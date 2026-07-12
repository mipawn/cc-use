use std::{collections::HashMap, sync::Mutex};

const KEYCHAIN_SERVICE: &str = "com.mipawn.cc-use.credentials";

#[derive(Debug, thiserror::Error)]
pub enum SecretStoreError {
    #[error("secret store operation failed: {0}")]
    Backend(String),
    #[error("secret {0} was not found")]
    NotFound(String),
    #[error("secret {0} is not valid UTF-8")]
    InvalidUtf8(String),
}

pub trait SecretStore: Send + Sync {
    fn get(&self, reference: &str) -> Result<String, SecretStoreError>;
    fn set(&self, reference: &str, value: &str) -> Result<(), SecretStoreError>;
    fn delete(&self, reference: &str) -> Result<(), SecretStoreError>;
}

pub struct SystemSecretStore;

#[cfg(target_os = "macos")]
impl SecretStore for SystemSecretStore {
    fn get(&self, reference: &str) -> Result<String, SecretStoreError> {
        let value =
            security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, reference)
                .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        String::from_utf8(value).map_err(|_| SecretStoreError::InvalidUtf8(reference.to_string()))
    }

    fn set(&self, reference: &str, value: &str) -> Result<(), SecretStoreError> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            reference,
            value.as_bytes(),
        )
        .map_err(|error| SecretStoreError::Backend(error.to_string()))
    }

    fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
        security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, reference)
            .map_err(|error| SecretStoreError::Backend(error.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for SystemSecretStore {
    fn get(&self, _reference: &str) -> Result<String, SecretStoreError> {
        Err(SecretStoreError::Backend(
            "system secret storage is only supported on macOS".to_string(),
        ))
    }

    fn set(&self, _reference: &str, _value: &str) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Backend(
            "system secret storage is only supported on macOS".to_string(),
        ))
    }

    fn delete(&self, _reference: &str) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Backend(
            "system secret storage is only supported on macOS".to_string(),
        ))
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, reference: &str) -> Result<String, SecretStoreError> {
        self.values
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?
            .get(reference)
            .cloned()
            .ok_or_else(|| SecretStoreError::NotFound(reference.to_string()))
    }

    fn set(&self, reference: &str, value: &str) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?
            .insert(reference.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?
            .remove(reference)
            .map(|_| ())
            .ok_or_else(|| SecretStoreError::NotFound(reference.to_string()))
    }
}

pub fn to_sqlite_error(error: SecretStoreError) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}
