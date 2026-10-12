import type { ReadinessFinding } from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import type { RejectionCode } from '../domain/lifecycle.js';

/** Domain rejection → stable API error (contract §15 error codes; §2.3 statuses). */
export function rejectionError(code: RejectionCode, message: string, findings?: ReadinessFinding[]): AppError {
  switch (code) {
    case 'version_conflict':
      return Errors.versionConflict();
    case 'PERMISSION_DENIED':
      return Errors.forbidden(message);
    case 'INVALID_TRANSITION':
      return new AppError('INVALID_TRANSITION', 409, message);
    case 'CAMPAIGN_NOT_EDITABLE':
      return new AppError('CAMPAIGN_NOT_EDITABLE', 422, message);
    case 'CAMPAIGN_ACTIVE':
      return new AppError('CAMPAIGN_ACTIVE', 422, message);
    case 'DELIVERY_NOT_AVAILABLE':
      return new AppError('DELIVERY_NOT_AVAILABLE', 422, message);
    case 'PREFLIGHT_FAILED':
      return new AppError('PREFLIGHT_FAILED', 422, message, undefined, undefined, findings);
  }
}

export const channelNotAvailable = () => new AppError('CHANNEL_NOT_AVAILABLE', 422, 'This channel is not available yet');
export const campaignNotFound = () => Errors.notFound('Campaign');
