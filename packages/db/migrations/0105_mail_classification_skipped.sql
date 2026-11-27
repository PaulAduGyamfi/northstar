ALTER TABLE "mail_classification" DROP CONSTRAINT "mail_classification_shape";--> statement-breakpoint
ALTER TABLE "mail_classification" ADD CONSTRAINT "mail_classification_shape" CHECK (("mail_classification"."outcome" = 'classified' and "mail_classification"."kind" is not null and "mail_classification"."kind" in ('confirmation', 'rejection', 'assessment', 'interview_request', 'scheduling', 'recruiter_inbound', 'follow_up_needed', 'offer', 'info_other')
            and "mail_classification"."stage_signal" is not null and "mail_classification"."stage_signal" in ('none', 'screen', 'technical', 'onsite', 'offer')
            and "mail_classification"."review_reason" is null)
        or ("mail_classification"."outcome" = 'review' and "mail_classification"."kind" is null and "mail_classification"."stage_signal" is null
            and "mail_classification"."review_reason" is not null
            and "mail_classification"."review_reason" in ('refused', 'truncated', 'invalid_output', 'ambiguous', 'provenance')
            and "mail_classification"."decided_by" = 'model')
        or ("mail_classification"."outcome" = 'skipped' and "mail_classification"."kind" is null and "mail_classification"."stage_signal" is null
            and "mail_classification"."review_reason" is null and "mail_classification"."decided_by" = 'rules'));
