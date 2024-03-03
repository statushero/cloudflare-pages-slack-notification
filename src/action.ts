import * as core from "@actions/core";
import * as github from "@actions/github";
import fetch, { Response } from "node-fetch";

import { context } from "@actions/github/lib/utils";
import { ApiResponse, AuthHeaders, Deployment } from "./types";
import SlackNotify from "slack-notify";

let waiting = true;
// @ts-ignore - Typing GitHub's responses is a pain in the ass
let ghDeployment;
let markedAsInProgress = false;

export default async function run() {
  const accountEmail = core.getInput("accountEmail", { required: false, trimWhitespace: true });
  const apiKey = core.getInput("apiKey", { required: false, trimWhitespace: true });
  const apiToken = core.getInput("apiToken", { required: false, trimWhitespace: true });

  const accountId = core.getInput("accountId", { required: true, trimWhitespace: true });
  const project = core.getInput("project", { required: true, trimWhitespace: true });
  const token = core.getInput("githubToken", { required: false, trimWhitespace: true });
  const commitHash = core.getInput("commitHash", { required: false, trimWhitespace: true });
  const slackWebHook = core.getInput("slackWebHook", { required: false, trimWhitespace: true });
  const slack = SlackNotify(slackWebHook);
  const commitUrl = context.payload?.head_commit?.url || "";
  const actor = context?.actor || "";

  // Validate we have either token or both email + key
  if (!validateAuthInputs(apiToken, accountEmail, apiKey)) {
    return;
  }

  const authHeaders: AuthHeaders =
    apiToken !== "" ? { Authorization: `Bearer ${apiToken}` } : { "X-Auth-Email": accountEmail, "X-Auth-Key": apiKey };

  console.log("Waiting for Pages to finish building...");
  let lastStage = "";

  while (waiting) {
    // We want to wait a few seconds, don't want to spam the API :)
    await sleep();

    const deployment: Deployment | undefined = await pollApi(authHeaders, accountId, project, commitHash);
    if (!deployment) {
      console.log("Waiting for the deployment to start...");
      continue;
    }

    if (deployment.is_skipped === true) {
      waiting = false;
      console.log(`Deployment skipped ${deployment.id}!`);
      core.setOutput(`Deployment skipped ${deployment.id}!`);
      return;
    }

    const latestStage = deployment.latest_stage;

    if (latestStage.name !== lastStage) {
      lastStage = deployment.latest_stage.name;
      console.log("# Now at stage: " + lastStage);

      if (!markedAsInProgress) {
        await updateDeployment(token, deployment, "in_progress");
        markedAsInProgress = true;
      }
    }

    if (latestStage.status === "failed" || latestStage.status === "failure") {
      waiting = false;

      if (slackWebHook) {
        const logs = await getCloudflareLogs(authHeaders, accountId, project, deployment.id);
        slack
          .send(
            `Deployment failed for project *${project}*\nCommit: ${commitUrl}\nActor: *${actor}*\nDeployment ID: *${deployment.id}*\nLogs: ${logs}\n`
          )
          .then(() => {
            console.log(`Slack message for ${latestStage.name} failed pipeline sent!`);
          })
          .catch((err) => {
            console.error(err);
          });
      }
      core.setFailed(`Deployment failed on step: ${latestStage.name}!`);
      await updateDeployment(token, deployment, "failure");
      return;
    }
    async function getCloudflareLogs(
      authHeaders: AuthHeaders,
      accountId: string,
      project: string,
      deploymentId: string
    ): Promise<string> {
      try {
        const res: Response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}/history/logs`,
          {
            headers: { ...authHeaders },
          }
        );

        if (!res.ok) {
          console.error(`Failed to fetch Cloudflare logs - Status code: ${res.status} (${res.statusText})`);
          return "";
        }

        const body = await res.json();

        if (Array.isArray(body.result?.data) && body.result.data.length > 0) {
          const logs = body.result.data.map((log: any) => {
            return {
              line: log.line,
            };
          });

          const last20Logs = logs.slice(-20);

          const formattedLogs = last20Logs.map((log) => {
            return `${log.line}`;
          });

          return "```" + formattedLogs.join("\n") + "\n```";
        } else {
          return "";
        }
      } catch (error) {
        console.error(`Failed to fetch Cloudflare logs: ${error.message}`);
        return "";
      }
    }

    if (latestStage.name === "deploy" && ["success", "failed"].includes(latestStage.status)) {
      waiting = false;

      const aliasUrl = deployment.aliases && deployment.aliases.length > 0 ? deployment.aliases[0] : deployment.url;

      // Set outputs
      core.setOutput("id", deployment.id);
      core.setOutput("environment", deployment.environment);
      core.setOutput("url", deployment.url);
      core.setOutput("alias", aliasUrl);
      core.setOutput("success", deployment.latest_stage.status === "success" ? true : false);

      if (deployment.latest_stage.status === "success" && true) {
        slack
          .send(
            `Deployment succeeded for project *${project}*\nCommit: ${commitUrl}\nActor: *${actor}*\nDeployment ID: *${deployment.id}*\nAlias URL: ${aliasUrl}\nDeployment URL: ${deployment.url}\n<https://dash.cloudflare.com?to=/${accountId}/pages/view/${deployment.project_name}/${deployment.id}|Logs>`
          )
          .then(() => {
            console.log("Slack message for DEPLOYMENT succeeded pipeline sent!");
          })
          .catch((err) => {
            console.error(err);
          });
      }
      // Update deployment (if enabled)
      if (token !== "") {
        await updateDeployment(token, deployment, latestStage.status === "success" ? "success" : "failure");
      }
    }
  }
}

function validateAuthInputs(token: string, email: string, key: string) {
  if (token !== "") {
    return true;
  }

  if (email !== "" && key !== "") {
    return true;
  }

  core.setFailed("Please specify authentication details! Set either `apiToken` or `accountEmail` + `accountKey`!");
  return false;
}

async function pollApi(
  authHeaders: AuthHeaders,
  accountId: string,
  project: string,
  commitHash: string
): Promise<Deployment | undefined> {
  // curl -X GET "https://api.cloudflare.com/client/v4/accounts/:account_id/pages/projects/:project_name/deployments" \
  //   -H "X-Auth-Email: user@example.com" \
  //   -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
  let res: Response;
  let body: ApiResponse;
  // Try and fetch, may fail due to a network issue
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?sort_by=created_on&sort_order=desc`,
      {
        headers: { ...authHeaders },
      }
    );
  } catch (e) {
    // @ts-ignore
    core.error(`Failed to send request to CF API - network issue? ${e.message}`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  // If the body isn't a JSON then fail - CF seems to do this sometimes?
  try {
    body = (await res.json()) as ApiResponse;
  } catch (e) {
    core.error(`CF API did not return a JSON (possibly down?) - Status code: ${res.status} (${res.statusText})`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  if (!body.success) {
    waiting = false;
    const error = body.errors.length > 0 ? body.errors[0] : "Unknown error!";
    core.setFailed(`Failed to check deployment status! Error: ${JSON.stringify(error)}`);
    return;
  }

  if (!commitHash) return body.result?.[0];
  return body.result?.find?.((deployment) => deployment.deployment_trigger?.metadata?.commit_hash === commitHash);
}

async function sleep() {
  return new Promise((resolve) => setTimeout(resolve, 5000));
}

// Credits to Greg for this code <3
async function updateDeployment(token: string, deployment: Deployment, state: "success" | "failure" | "in_progress") {
  if (!token) return;

  const octokit = github.getOctokit(token);

  const environment =
    deployment.environment === "production"
      ? "Production"
      : `Preview (${deployment.deployment_trigger.metadata.branch})`;

  const sharedOptions = {
    owner: context.repo.owner,
    repo: context.repo.repo,
  };

  // @ts-ignore
  if (!ghDeployment) {
    const { data } = await octokit.rest.repos.createDeployment({
      ...sharedOptions,
      ref: deployment.deployment_trigger.metadata.commit_hash,
      auto_merge: false,
      environment,
      production_environment: deployment.environment === "production",
      description: "Cloudflare Pages",
      required_contexts: [],
    });
    ghDeployment = data;
  }

  if (deployment.latest_stage.name === "deploy" && ["success", "failed"].includes(deployment.latest_stage.status)) {
    // @ts-ignore - Env is not typed correctly
    await octokit.rest.repos.createDeploymentStatus({
      ...sharedOptions,
      // @ts-ignore - Typing createDeployment is a pain
      deployment_id: ghDeployment.id,
      // @ts-ignore - Env is not typed correctly
      environment,
      environment_url: deployment.url,
      log_url: `https://dash.cloudflare.com?to=/:account/pages/view/${deployment.project_name}/${deployment.id}`,
      description: "Cloudflare Pages",
      state,
    });
  }
}

try {
  run();
} catch (e) {
  console.error("Please report this! Issues: https://github.com/WalshyDev/cf-pages-await/issues");
  // @ts-ignore
  core.setFailed(e);
  // @ts-ignore
  console.error(e.message + "\n" + e.stack);
}
