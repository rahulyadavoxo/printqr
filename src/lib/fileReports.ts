import type { Key } from './i18n'

/** v34 "Report file": the reasons public.file_reports accepts (same list as its check constraint). */
export const FILE_REPORT_REASONS = ['csam', 'illegal', 'violence', 'copyright', 'privacy', 'other'] as const
export type FileReportReason = (typeof FILE_REPORT_REASONS)[number]

export const FILE_REPORT_REASON_KEY: Record<string, Key> = {
  csam: 'frReasonCsam', illegal: 'frReasonIllegal', violence: 'frReasonViolence',
  copyright: 'frReasonCopyright', privacy: 'frReasonPrivacy', other: 'frReasonOther'
}
