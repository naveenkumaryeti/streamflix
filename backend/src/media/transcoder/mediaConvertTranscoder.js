import { CreateJobCommand, GetJobCommand, MediaConvertClient } from '@aws-sdk/client-mediaconvert';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import { hlsPrefix, masterPlaylistKey } from '../keys.js';

/**
 * AWS Elemental MediaConvert transcoder.
 *
 * Same contract as the ffmpeg driver, but the CPU-minutes happen in a managed service:
 * `submit` returns immediately with a job id, and either the worker polls it or an
 * EventBridge rule posts the completion to /internal/transcode/callback.
 *
 * Layout note: MediaConvert names variants by appending a modifier to the destination base
 * (`hls/<id>/master_720p.m3u8`) instead of ffmpeg's per-rendition directories. Only the
 * master playlist key is ever handed to a player, so the difference stays inside this file.
 */
export const name = 'mediaconvert';
export const isAsync = true;

const client = new MediaConvertClient({
  region: config.aws.region,
  endpoint: config.mediaConvert.endpoint || undefined,
});

const STATUS = {
  SUBMITTED: 'submitted',
  PROGRESSING: 'processing',
  COMPLETE: 'succeeded',
  ERROR: 'failed',
  CANCELED: 'canceled',
};

function assertConfigured() {
  const missing = Object.entries({
    MEDIACONVERT_ENDPOINT: config.mediaConvert.endpoint,
    MEDIACONVERT_ROLE_ARN: config.mediaConvert.roleArn,
    S3_BUCKET_PROCESSED: config.s3.processedBucket,
    S3_BUCKET_RAW: config.s3.rawBucket,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`MediaConvert is not configured: missing ${missing.join(', ')}`);
}

/** QVBR rather than fixed CBR: same perceptual quality at a noticeably lower bill. */
const videoOutput = (rendition) => ({
  NameModifier: `_${rendition.name}`,
  ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
  VideoDescription: {
    Height: rendition.height,
    ScalingBehavior: 'DEFAULT',
    CodecSettings: {
      Codec: 'H_264',
      H264Settings: {
        RateControlMode: 'QVBR',
        QvbrSettings: { QvbrQualityLevel: 7 },
        MaxBitrate: rendition.videoBitrate * 1000,
        SceneChangeDetect: 'TRANSITION_DETECTION',
        GopSizeUnits: 'SECONDS',
        GopSize: 2,
        QualityTuningLevel: 'SINGLE_PASS_HQ',
      },
    },
  },
  AudioDescriptions: [
    {
      AudioSourceName: 'Audio Selector 1',
      CodecSettings: {
        Codec: 'AAC',
        AacSettings: { Bitrate: rendition.audioBitrate * 1000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
      },
    },
  ],
});

export function buildJobSettings({ titleId, inputKey, renditions = config.media.renditions }) {
  const destination = `s3://${config.s3.processedBucket}/${hlsPrefix(titleId)}/master`;
  const thumbnails = `s3://${config.s3.thumbnailBucket || config.s3.processedBucket}/images/${titleId}/`;

  return {
    TimecodeConfig: { Source: 'ZEROBASED' },
    Inputs: [
      {
        FileInput: `s3://${config.s3.rawBucket}/${inputKey}`,
        TimecodeSource: 'ZEROBASED',
        VideoSelector: { Rotate: 'AUTO' },
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      },
    ],
    OutputGroups: [
      {
        Name: 'Apple HLS',
        OutputGroupSettings: {
          Type: 'HLS_GROUP_SETTINGS',
          HlsGroupSettings: {
            Destination: destination,
            SegmentLength: 6,
            MinSegmentLength: 0,
            DirectoryStructure: 'SINGLE_DIRECTORY',
            SegmentControl: 'SEGMENTED_FILES',
            ManifestDurationFormat: 'INTEGER',
            StreamInfResolution: 'INCLUDE',
          },
        },
        Outputs: renditions.map(videoOutput),
      },
      {
        // Best-effort poster. Admins can always upload their own artwork instead.
        Name: 'Poster',
        OutputGroupSettings: { Type: 'FILE_GROUP_SETTINGS', FileGroupSettings: { Destination: thumbnails } },
        Outputs: [
          {
            NameModifier: 'poster',
            ContainerSettings: { Container: 'RAW' },
            VideoDescription: {
              Height: 720,
              CodecSettings: {
                Codec: 'FRAME_CAPTURE',
                FrameCaptureSettings: { FramerateNumerator: 1, FramerateDenominator: 60, MaxCaptures: 1, Quality: 80 },
              },
            },
          },
        ],
      },
    ],
  };
}

export async function submit({ jobId, titleId, inputKey }) {
  assertConfigured();
  const response = await client.send(
    new CreateJobCommand({
      Role: config.mediaConvert.roleArn,
      Queue: config.mediaConvert.queueArn || undefined,
      StatusUpdateInterval: 'SECONDS_10',
      UserMetadata: { titleId: String(titleId), jobId: String(jobId) },
      Settings: buildJobSettings({ titleId, inputKey }),
    }),
  );

  logger.info({ titleId, externalJobId: response.Job?.Id }, 'mediaconvert job submitted');
  return { provider: name, externalJobId: response.Job?.Id ?? null, status: STATUS[response.Job?.Status] ?? 'submitted' };
}

export async function poll({ externalJobId, titleId }) {
  if (!externalJobId) return null;
  const { Job } = await client.send(new GetJobCommand({ Id: externalJobId }));
  const status = STATUS[Job?.Status] ?? 'processing';
  const renditions = config.media.renditions.map((rendition) => ({
    name: rendition.name,
    height: rendition.height,
    bitrateKbps: rendition.videoBitrate,
    playlistKey: `${hlsPrefix(titleId)}/master_${rendition.name}.m3u8`,
  }));

  return {
    status,
    progress: Number(Job?.JobPercentComplete ?? 0),
    errorMessage: Job?.ErrorMessage ?? null,
    durationSeconds: Math.round(Number(Job?.OutputGroupDetails?.[0]?.OutputDetails?.[0]?.DurationInMs ?? 0) / 1000),
    hlsKey: status === 'succeeded' ? masterPlaylistKey(titleId) : null,
    renditions: status === 'succeeded' ? renditions : [],
  };
}

export default { name, isAsync, submit, poll, buildJobSettings };
