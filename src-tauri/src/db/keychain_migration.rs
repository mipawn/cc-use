const KEYCHAIN_SERVICE: &str = "com.mipawn.cc-use.credentials";

#[derive(Debug, thiserror::Error)]
pub enum LegacySecretReadError {
    #[error("legacy Keychain read failed: {0}")]
    Backend(String),
    #[error("legacy Keychain secret {0} is not valid UTF-8")]
    InvalidUtf8(String),
    #[error("legacy Keychain reader is unavailable for {0}")]
    Unavailable(String),
}

pub trait LegacySecretReader {
    fn get(&self, reference: &str) -> Result<String, LegacySecretReadError>;
}

pub struct SystemKeychainReader;

#[cfg(target_os = "macos")]
impl LegacySecretReader for SystemKeychainReader {
    fn get(&self, reference: &str) -> Result<String, LegacySecretReadError> {
        let value =
            security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, reference)
                .map_err(|error| LegacySecretReadError::Backend(error.to_string()))?;
        String::from_utf8(value)
            .map_err(|_| LegacySecretReadError::InvalidUtf8(reference.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
impl LegacySecretReader for SystemKeychainReader {
    fn get(&self, _reference: &str) -> Result<String, LegacySecretReadError> {
        Err(LegacySecretReadError::Backend(
            "legacy Keychain migration is only supported on macOS".to_string(),
        ))
    }
}

pub fn to_sqlite_error(error: LegacySecretReadError) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}
