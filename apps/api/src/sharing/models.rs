#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FormRole {
    Owner,
    Editor,
    Viewer,
}

impl FormRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }
}

impl TryFrom<&str> for FormRole {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "owner" => Ok(Self::Owner),
            "editor" => Ok(Self::Editor),
            "viewer" => Ok(Self::Viewer),
            _ => Err(anyhow::anyhow!("unknown form role")),
        }
    }
}

#[derive(serde::Deserialize)]
pub struct PutSharingKeyBody {
    pub expected_user_id: uuid::Uuid,
    pub sharing_public_key: String,
    pub wrapped_sharing_private_key: String,
    pub sharing_key_version: i16,
}

#[derive(serde::Serialize)]
pub struct SharingKeyResponse {
    pub user_id: uuid::Uuid,
    pub sharing_public_key: Option<String>,
    pub wrapped_sharing_private_key: Option<String>,
    pub sharing_key_version: Option<i16>,
}

#[derive(serde::Deserialize)]
pub struct RecipientKeyBody {
    pub invited_email: String,
}

#[derive(serde::Serialize)]
pub struct RecipientKeyResponse {
    pub sharing_public_key: Option<String>,
    pub sharing_key_version: Option<i16>,
}

#[derive(serde::Deserialize)]
pub struct InvitationBody {
    pub invited_email: String,
    pub role: FormRole,
    pub recipient_sharing_public_key: Option<String>,
    pub encrypted_form_data_key: Option<String>,
    pub encrypted_form_private_key: Option<String>,
}

#[derive(serde::Serialize)]
pub struct InvitationResponse {
    pub id: uuid::Uuid,
}

#[derive(serde::Deserialize)]
pub struct ContinueInvitationBody {
    pub token: String,
}

#[derive(serde::Serialize)]
pub struct CurrentInvitationResponse {
    pub role: FormRole,
    pub status: &'static str,
    pub masked_email: String,
    pub grant_ready: bool,
}

#[derive(serde::Serialize)]
pub struct InvitationAcceptanceResponse {
    pub form_id: uuid::Uuid,
    pub membership_state: &'static str,
}

#[derive(serde::Deserialize)]
pub struct UpdateMemberRoleBody {
    pub role: FormRole,
}

#[derive(serde::Deserialize)]
pub struct TransferOwnershipBody {
    pub member_id: uuid::Uuid,
}

/// Body for `PATCH /forms/:id/members/me`: the caller's own per-form state.
///
/// Both fields are optional so a request may set either or both; omitting one
/// leaves it unchanged. `archived` uses a plain `Option<bool>` (unlike the
/// `present`/`present_rfc3339` absent-vs-null distinction used for
/// `closes_at`/`max_responses` in `forms::routes`) because there is no "clear
/// it" state to express here: archived is either set or left alone, never
/// nulled independently of being set to `false`.
#[derive(serde::Deserialize)]
pub struct MemberPreferencesBody {
    pub notify_on_response: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(serde::Serialize)]
pub struct CollaborationMember {
    pub id: uuid::Uuid,
    pub email: String,
    pub role: FormRole,
    pub state: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

#[derive(serde::Serialize)]
pub struct CollaborationInvitation {
    pub id: uuid::Uuid,
    pub invited_email: String,
    pub role: FormRole,
    pub status: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<time::OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

#[derive(serde::Serialize)]
pub struct CollaborationResponse {
    pub members: Vec<CollaborationMember>,
    pub invitations: Vec<CollaborationInvitation>,
}

#[derive(serde::Serialize)]
pub struct ProvisioningItem {
    pub form_id: uuid::Uuid,
    pub member_id: uuid::Uuid,
    pub recipient_sharing_public_key: String,
    pub owner_key_scheme: String,
    pub owner_encrypted_form_data_key: String,
    pub owner_encrypted_form_private_key: String,
}

#[derive(serde::Serialize)]
pub struct ProvisioningResponse {
    pub items: Vec<ProvisioningItem>,
}

#[derive(serde::Deserialize)]
pub struct PutMemberGrantBody {
    pub recipient_sharing_public_key: String,
    pub encrypted_form_data_key: String,
    pub encrypted_form_private_key: String,
}

#[derive(serde::Serialize)]
pub struct MembershipStateResponse {
    pub membership_state: &'static str,
}

#[cfg(test)]
mod tests {
    use super::FormRole;

    #[test]
    fn form_role_parses_only_known_database_values() {
        assert_eq!(FormRole::try_from("owner").unwrap().as_str(), "owner");
        assert_eq!(FormRole::try_from("editor").unwrap().as_str(), "editor");
        assert_eq!(FormRole::try_from("viewer").unwrap().as_str(), "viewer");
        assert!(FormRole::try_from("administrator").is_err());
    }
}
