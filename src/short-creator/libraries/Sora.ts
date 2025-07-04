// Placeholder for Sora API client
// Details to be filled in based on Azure Sora API specifics

import { logger } from "../../logger";
import { OrientationEnum, Video } from "../../types/shorts";
import { getOrientationConfig } from "../../components/utils";

// Define a type for the Sora job initiation response (expected to include a job ID)
interface SoraJobInitiationResponse {
  id: string; // Assuming the job ID is returned with the key 'id'
  // ... any other relevant fields from the initiation response
}

// Define a type for the Sora job status response
interface SoraGeneration {
  object: string; // e.g., "video.generation"
  id: string; // Generation ID, e.g., "gen_..."
  job_id: string;
  created_at: number;
  width?: number;
  height?: number;
  n_seconds?: number;
  prompt?: string;
  url?: string; // This is the field we hope to find for the video URL
  // Allow any other fields as the API might evolve
  [key: string]: any;
}

interface SoraJobStatusResponse {
  object: string; // e.g., "video.generation.job"
  id: string; // Job ID, e.g., "task_..."
  status: string; // Status like "succeeded", "failed", "running", "preprocessing", "queued"
  created_at: number;
  finished_at?: number;
  expires_at?: number;
  generations?: SoraGeneration[];
  prompt?: string; // Top-level prompt for the job
  model?: string;
  n_variants?: number;
  n_seconds?: number; // Top-level requested n_seconds
  height?: number; // Top-level requested height
  width?: number; // Top-level requested width
  failure_reason?: string | null;
  error?: {
    // Error object if status is "failed"
    message: string;
    code?: string;
    // ... any other error details
  };
  // Allow any other fields
  [key: string]: any;
}

export class SoraAPI {
  private apiKey: string;
  private apiEndpoint: string;
  private pollIntervalMs: number;
  private pollTimeoutMs: number;

  constructor(
    apiKey: string,
    apiEndpoint: string,
    pollIntervalMs = 5000, // Default poll interval: 5 seconds
    pollTimeoutMs = 300000, // Default poll timeout: 5 minutes
  ) {
    if (!apiKey) {
      throw new Error("Sora API key not provided.");
    }
    if (!apiEndpoint) {
      throw new Error("Sora API endpoint not provided.");
    }
    this.apiKey = apiKey;
    this.apiEndpoint = apiEndpoint;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    logger.info(
      { apiEndpoint, pollIntervalMs, pollTimeoutMs },
      "SoraAPI client initialized.",
    );
  }

  private async initiateVideoGeneration(
    prompt: string,
    durationSeconds: number,
    width: number,
    height: number,
  ): Promise<string> {
    // this.apiEndpoint is expected to be the full URL for initiating the job,
    // e.g., "https://<resource>.openai.azure.com/openai/v1/video/generations/jobs?api-version=preview"
    const requestUrl = this.apiEndpoint;
    const payload = {
      model: "sora", // Assuming "sora" is the model identifier
      prompt,
      height: height.toString(),
      width: width.toString(),
      n_seconds: Math.max(1, Math.round(durationSeconds)).toString(), // Ensure at least 1 second
      n_variants: "1",
    };

    logger.debug(
      { url: requestUrl, payload },
      "Initiating Sora video generation job.",
    );

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-key": this.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, errorBody, url: requestUrl },
        "Sora API error initiating job.",
      );
      throw new Error(
        `Sora API error initiating job: ${response.status} ${response.statusText} - ${errorBody}`,
      );
    }

    // The user-provided cURL starts a job but doesn't show the immediate response.
    // Typically, such an API call would return a response containing the job ID.
    // For Azure async operations, the job ID might be in a header like 'operation-location' or in the body.
    // Let's assume for now it's in the body as `id`.
    // We also need the URL to poll for status, which is often related to this initial response.
    // The cURL example shows POST to /jobs. Let's assume GET to /jobs/{jobId} for status.

    const responseData = (await response.json()) as SoraJobInitiationResponse; // Or some other structure

    // Critical Assumption: The responseData contains an 'id' for the job.
    // And that the status can be checked at a URL like /jobs/{id}
    // This part is speculative due to missing documentation for job status polling.
    // The initial POST might return a `Location` or `Operation-Location` header with the status poll URL.
    // Let's check for `Operation-Location` header first as it's common in Azure REST APIs for async operations.
    const operationLocationUrl = response.headers.get("operation-location");
    if (operationLocationUrl) {
      logger.info(
        { operationLocationUrl },
        "Received operation-location header for polling.",
      );
      // This URL is likely the direct URL to poll for the job status.
      // We'll need to extract the job ID from it if we want to construct it ourselves, or just use this URL.
      // For simplicity, we might just store and use this full URL for polling.
      // However, our current structure expects a jobID to be returned.
      // Let's assume the job ID is the last part of the path in operationLocationUrl.
      const parts = operationLocationUrl.split("/");
      const jobId = parts.pop() || parts.pop(); // Handle trailing slash
      if (!jobId) {
        throw new Error(
          "Could not extract job ID from operation-location header.",
        );
      }
      logger.info(
        { jobId },
        "Extracted job ID from operation-location header.",
      );
      return jobId; // Or return the full operationLocationUrl if the polling function is adapted
    } else if (responseData && responseData.id) {
      logger.info(
        { jobId: responseData.id },
        "Received job ID in response body.",
      );
      return responseData.id;
    } else {
      logger.error(
        { responseHeaders: response.headers, responseBody: responseData },
        "Sora API did not return a job ID or operation-location header.",
      );
      throw new Error(
        "Sora API did not return a job ID or operation-location header.",
      );
    }
  }

  private async pollForJobCompletion(
    jobId: string,
  ): Promise<SoraJobStatusResponse> {
    const startTime = Date.now();

    // Construct the status URL by inserting the jobId into the apiEndpoint path.
    // this.apiEndpoint is like: "https://<resource>.openai.azure.com/openai/v1/video/generations/jobs?api-version=preview"
    // We want: "https://<resource>.openai.azure.com/openai/v1/video/generations/jobs/{jobId}?api-version=preview"

    let statusUrl = "";
    try {
      const endpointUrl = new URL(this.apiEndpoint);
      // Assuming the path is something like /openai/v1/video/generations/jobs
      // We append the jobId to this path.
      const basePath = endpointUrl.pathname; // e.g., /openai/v1/video/generations/jobs
      endpointUrl.pathname = `${basePath}/${jobId}`; // e.g., /openai/v1/video/generations/jobs/test-job-id-123
      statusUrl = endpointUrl.toString();
    } catch (e) {
      logger.error(
        { error: e, apiEndpoint: this.apiEndpoint },
        "Failed to parse apiEndpoint to construct status URL",
      );
      throw new Error(
        "Invalid API Endpoint format for constructing status URL.",
      );
    }

    logger.debug({ statusUrl, jobId }, "Polling Sora job status.");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startTime > this.pollTimeoutMs) {
        logger.error(
          { jobId, pollTimeoutMs: this.pollTimeoutMs },
          "Sora job polling timed out.",
        );
        throw new Error(`Sora job polling timed out for job ID: ${jobId}`);
      }

      try {
        const response = await fetch(statusUrl, {
          method: "GET",
          headers: {
            "Api-key": this.apiKey,
          },
        });

        if (!response.ok) {
          const errorBody = await response.text();
          // Specific handling for 404 if job ID is not found or job expired
          if (response.status === 404) {
            logger.error(
              { status: response.status, errorBody, jobId },
              "Sora job not found (404). It might have expired or the ID is incorrect.",
            );
            throw new Error(
              `Sora job not found (404) for job ID: ${jobId}. ${errorBody}`,
            );
          }
          logger.warn(
            { status: response.status, errorBody, jobId },
            "Sora API error polling job status. Retrying...",
          );
          // For other server-side errors, we'll retry after a delay.
          await new Promise((resolve) =>
            setTimeout(resolve, this.pollIntervalMs),
          );
          continue;
        }

        const statusData = (await response.json()) as SoraJobStatusResponse;
        logger.debug(
          { jobId, status: statusData.status, response: statusData },
          "Sora job status update.",
        ); // Log full response for debug

        const currentStatus = statusData.status.toLowerCase();

        if (currentStatus === "succeeded") {
          logger.info(
            { jobId, response: statusData },
            "Sora job succeeded according to API.",
          );
          const firstGeneration = statusData.generations?.[0];
          if (firstGeneration?.url) {
            // Successfully found URL
            return statusData;
          } else {
            // Succeeded, but no URL found where expected
            logger.error(
              { jobId, response: statusData },
              "Sora job status is 'succeeded' but no video URL found in generations[0].url.",
            );
            // This is a terminal error for this attempt, should not be caught by the polling retry catch block.
            throw new Error(
              "Sora job succeeded but video data is missing or in an unexpected format.",
            );
          }
        } else if (currentStatus === "failed" || currentStatus === "canceled") {
          logger.error(
            {
              jobId,
              status: statusData.status,
              error: statusData.error,
              response: statusData,
            },
            "Sora job failed or was canceled by API.",
          );
          // This is a terminal error, should not be caught by the polling retry catch block.
          throw new Error(
            `Sora job ${jobId} ${statusData.status}: ${statusData.error?.message || "Unknown error details not provided by API."}`,
          );
        }
        // If status is "running", "preprocessing", "queued", etc., continue polling.
        // No action needed here, the loop will continue.
      } catch (error: any) {
        // Only handle fetch/network/unexpected errors here
        logger.warn(
          { error: error.message, jobId, stack: error.stack },
          "Network or unexpected error during polling, retrying...",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  public async generateVideo(
    prompt: string,
    durationSeconds: number,
    orientation: OrientationEnum = OrientationEnum.portrait,
  ): Promise<Video> {
    logger.info(
      { prompt, durationSeconds, orientation },
      "Requesting video from Sora.",
    );
    const { width, height } = getOrientationConfig(orientation);

    const jobId = await this.initiateVideoGeneration(
      prompt,
      durationSeconds,
      width,
      height,
    );

    const completedJob = await this.pollForJobCompletion(jobId); // This will now throw if URL is not found on success

    // completedJob here is guaranteed to be a "succeeded" status with a generations[0].url if no error was thrown
    const videoUrl = completedJob.generations![0].url!; // Safe due to checks in pollForJobCompletion

    logger.info(
      { jobId, videoUrl },
      "Sora video generated successfully and URL retrieved.",
    );
    // Sora API doesn't give a persistent ID for the video itself, use the job ID or a new cuid
    // For now, let's use a new cuid as the video ID for consistency with how Pexels was handled (though Pexels IDs were from the service)
    // The 'id' here is more like a temporary identifier for the downloaded clip in our system if needed.
    // The URL is the most important part.
    return {
      id: `sora-${jobId}`, // Or use cuid() if a unique ID for this specific instance is needed
      url: videoUrl,
      width, // Assuming the generated video matches requested dimensions
      height,
    };
    // The 'else' block here is no longer needed because pollForJobCompletion
    // will throw an error if the job does not succeed with a URL.
    // If pollForJobCompletion returns, 'completedJob' is guaranteed to be successful
    // and contain the necessary URL.
  }
}
