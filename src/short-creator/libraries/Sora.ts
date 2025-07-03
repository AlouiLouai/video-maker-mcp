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
interface SoraJobStatusResponse {
  status: "NotStarted" | "Running" | "Succeeded" | "Failed" | "Canceled"; // Typical Azure job statuses
  result?: { // Assuming results are nested if the job succeeded
    videos?: Array<{
      url: string; // URL to the generated video
      // ... any other relevant video metadata (e.g., duration, size)
    }>;
  };
  error?: {
    message: string;
    // ... any other error details
  };
  // ... any other relevant fields from the status response
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
    logger.info({ apiEndpoint, pollIntervalMs, pollTimeoutMs }, "SoraAPI client initialized.");
  }

  private async initiateVideoGeneration(
    prompt: string,
    durationSeconds: number,
    width: number,
    height: number,
  ): Promise<string> {
    const requestUrl = `${this.apiEndpoint}/openai/v1/video/generations/jobs?api-version=preview`; // Using the endpoint structure from user
    const payload = {
      model: "sora", // Assuming "sora" is the model identifier
      prompt,
      height: height.toString(),
      width: width.toString(),
      n_seconds: Math.max(1, Math.round(durationSeconds)).toString(), // Ensure at least 1 second
      n_variants: "1",
    };

    logger.debug({ url: requestUrl, payload }, "Initiating Sora video generation job.");

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
      logger.error({ status: response.status, errorBody, url: requestUrl }, "Sora API error initiating job.");
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
        logger.info({ operationLocationUrl }, "Received operation-location header for polling.");
        // This URL is likely the direct URL to poll for the job status.
        // We'll need to extract the job ID from it if we want to construct it ourselves, or just use this URL.
        // For simplicity, we might just store and use this full URL for polling.
        // However, our current structure expects a jobID to be returned.
        // Let's assume the job ID is the last part of the path in operationLocationUrl.
        const parts = operationLocationUrl.split('/');
        const jobId = parts.pop() || parts.pop(); // Handle trailing slash
        if (!jobId) {
            throw new Error("Could not extract job ID from operation-location header.");
        }
        logger.info({ jobId }, "Extracted job ID from operation-location header.");
        return jobId; // Or return the full operationLocationUrl if the polling function is adapted
    } else if (responseData && responseData.id) {
        logger.info({ jobId: responseData.id }, "Received job ID in response body.");
        return responseData.id;
    } else {
        logger.error({ responseHeaders: response.headers, responseBody: responseData }, "Sora API did not return a job ID or operation-location header.");
        throw new Error("Sora API did not return a job ID or operation-location header.");
    }
  }

  private async pollForJobCompletion(jobId: string): Promise<SoraJobStatusResponse> {
    const startTime = Date.now();
    // Construct the likely status URL based on the job ID. This is an assumption.
    // The actual URL might be part of the response from the job initiation call (e.g., in a 'Location' or 'Operation-Location' header)
    const statusUrl = `${this.apiEndpoint}/openai/v1/video/generations/jobs/${jobId}?api-version=preview`;

    logger.debug({ statusUrl, jobId }, "Polling Sora job status.");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startTime > this.pollTimeoutMs) {
        logger.error({ jobId, pollTimeoutMs: this.pollTimeoutMs }, "Sora job polling timed out.");
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
             logger.error({ status: response.status, errorBody, jobId }, "Sora job not found (404). It might have expired or the ID is incorrect.");
             throw new Error(`Sora job not found (404) for job ID: ${jobId}. ${errorBody}`);
          }
          logger.warn({ status: response.status, errorBody, jobId }, "Sora API error polling job status. Retrying...");
          // For other server-side errors, we'll retry after a delay.
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
          continue;
        }

        const statusData = (await response.json()) as SoraJobStatusResponse;
        logger.debug({ jobId, status: statusData.status }, "Sora job status update.");

        if (statusData.status === "Succeeded") {
          logger.info({ jobId }, "Sora job succeeded.");
          return statusData;
        } else if (statusData.status === "Failed" || statusData.status === "Canceled") {
          logger.error({ jobId, status: statusData.status, error: statusData.error }, "Sora job failed or was canceled.");
          throw new Error(
            `Sora job ${jobId} ${statusData.status}: ${statusData.error?.message || "Unknown error"}`,
          );
        }
        // If "Running" or "NotStarted", continue polling after interval
      } catch (error) {
        // Handle network errors or other unexpected issues during polling
        logger.warn({ error, jobId }, "Error during polling, retrying...");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  public async generateVideo(
    prompt: string,
    durationSeconds: number,
    orientation: OrientationEnum = OrientationEnum.portrait,
  ): Promise<Video> {
    logger.info({ prompt, durationSeconds, orientation }, "Requesting video from Sora.");
    const { width, height } = getOrientationConfig(orientation);

    const jobId = await this.initiateVideoGeneration(
      prompt,
      durationSeconds,
      width,
      height,
    );

    const completedJob = await this.pollForJobCompletion(jobId);

    if (
      completedJob.status === "Succeeded" &&
      completedJob.result?.videos &&
      completedJob.result.videos.length > 0 &&
      completedJob.result.videos[0].url
    ) {
      const videoUrl = completedJob.result.videos[0].url;
      logger.info({ jobId, videoUrl }, "Sora video generated successfully.");
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
    } else {
      logger.error({ jobId, status: completedJob.status, result: completedJob.result }, "Sora job did not succeed or video URL is missing.");
      throw new Error(
        `Sora job ${jobId} completed but no video URL was found. Status: ${completedJob.status}`,
      );
    }
  }
}

// Example usage (for testing purposes, would not be here in final code)
/*
async function testSora() {
  const apiKey = process.env.SORA_API_KEY;
  const apiEndpoint = process.env.SORA_API_ENDPOINT;

  if (!apiKey || !apiEndpoint) {
    logger.error("SORA_API_KEY and SORA_API_ENDPOINT environment variables must be set for testing.");
    return;
  }

  const sora = new SoraAPI(apiKey, apiEndpoint);

  try {
    const prompt = "A serene beach at sunset, with gentle waves.";
    const duration = 7; // seconds
    const orientation = OrientationEnum.landscape;

    logger.info(`Attempting to generate video with prompt: "${prompt}"`);
    const video = await sora.generateVideo(prompt, duration, orientation);
    logger.info({ video }, "Successfully generated video from Sora:");
  } catch (error) {
    logger.error({ error }, "Error testing Sora API:");
  }
}

// To run test:
// SORA_API_KEY="your_key" SORA_API_ENDPOINT="your_endpoint" node -e "require('./Sora.ts').testSora()"
// Make sure to compile TS to JS first or use ts-node.
*/
