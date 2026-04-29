//! [`CompositeChannel`] — wraps a Nostr channel and side-delivers to Telegram.

use anyhow::Result;
use async_trait::async_trait;
use std::sync::Arc;
use tenex_protocol::{Channel, ChannelError, EncodingContext, Intent, MessageRef, PrincipalRef};

use crate::config::TelegramAgentConfig;
use crate::delivery::{deliver_intent, TelegramContext};

pub struct CompositeChannel {
    inner: Arc<dyn Channel>,
    agent_cfg: TelegramAgentConfig,
    tg_ctx: TelegramContext,
    publish_conversation: bool,
}

impl CompositeChannel {
    pub fn new(
        inner: Arc<dyn Channel>,
        agent_cfg: TelegramAgentConfig,
        tg_ctx: TelegramContext,
        publish_conversation: bool,
    ) -> Self {
        Self {
            inner,
            agent_cfg,
            tg_ctx,
            publish_conversation,
        }
    }
}

#[async_trait]
impl Channel for CompositeChannel {
    fn name(&self) -> &'static str {
        "nostr+telegram"
    }

    fn identity(&self) -> &PrincipalRef {
        self.inner.identity()
    }

    async fn send(
        &self,
        intent: Intent,
        ctx: &EncodingContext,
    ) -> Result<Vec<MessageRef>, ChannelError> {
        let refs = self.inner.send(intent.clone(), ctx).await?;

        if let Err(e) = deliver_intent(
            &intent,
            &self.tg_ctx,
            &self.agent_cfg,
            self.publish_conversation,
        )
        .await
        {
            tracing::warn!(error = %e, "Telegram delivery failed (non-fatal)");
        }

        Ok(refs)
    }
}
