use crate::ports::FileStore;
use crate::shortcuts::{
    MENU_CLOSE_PANE, MENU_CLOSE_TAB, MENU_FOCUS_NEXT_PANE, MENU_MOVE_TAB, MENU_NEXT_TAB,
    MENU_PREVIOUS_TAB, MENU_SPLIT_TAB, menu_select_id,
};
use serde_json::Value;

pub const FILE_NAME: &str = "settings.json";
pub const VERSION: u64 = 1;

const RESERVED: [&str; 15] = [
    "CmdOrCtrl+Q",
    "CmdOrCtrl+Ctrl+Q",
    "CmdOrCtrl+H",
    "CmdOrCtrl+Alt+H",
    "CmdOrCtrl+M",
    "CmdOrCtrl+C",
    "CmdOrCtrl+V",
    "CmdOrCtrl+X",
    "CmdOrCtrl+A",
    "CmdOrCtrl+Z",
    "CmdOrCtrl+Shift+Z",
    "CmdOrCtrl+Tab",
    "CmdOrCtrl+Shift+Tab",
    "CmdOrCtrl+Shift+W",
    "CmdOrCtrl+Alt+W",
];

const PUNCTUATION: &str = "\\[],./-=;'";
const MAX_FUNCTION_KEY: u8 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    UnknownKey,
    NeedsModifier,
    Reserved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    Char(char),
    Tab,
    Left,
    Right,
    Up,
    Down,
    Function(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accelerator {
    primary: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
    key: Key,
}

fn parse_key(token: &str) -> Option<Key> {
    let mut characters = token.chars();
    if let (Some(only), None) = (characters.next(), characters.next()) {
        if only.is_ascii_alphanumeric() {
            return Some(Key::Char(only.to_ascii_uppercase()));
        }
        return PUNCTUATION.contains(only).then_some(Key::Char(only));
    }
    let lowered = token.to_ascii_lowercase();
    match lowered.as_str() {
        "tab" => return Some(Key::Tab),
        "left" | "arrowleft" => return Some(Key::Left),
        "right" | "arrowright" => return Some(Key::Right),
        "up" | "arrowup" => return Some(Key::Up),
        "down" | "arrowdown" => return Some(Key::Down),
        _ => {}
    }
    let number: u8 = lowered.strip_prefix('f')?.parse().ok()?;
    ((1..=MAX_FUNCTION_KEY).contains(&number) && !lowered[1..].starts_with('0'))
        .then_some(Key::Function(number))
}

impl Accelerator {
    pub fn parse(text: &str) -> Result<Self, Refusal> {
        let tokens: Vec<&str> = text.split('+').collect();
        let Some((key, modifiers)) = tokens.split_last() else {
            return Err(Refusal::Malformed);
        };
        let mut found = Self {
            primary: false,
            ctrl: false,
            alt: false,
            shift: false,
            key: Key::Tab,
        };
        for token in modifiers {
            let slot = match token.to_ascii_lowercase().as_str() {
                "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "commandorctrl" | "cmd"
                | "command" | "super" | "meta" => &mut found.primary,
                "ctrl" | "control" => &mut found.ctrl,
                "alt" | "option" => &mut found.alt,
                "shift" => &mut found.shift,
                _ => return Err(Refusal::Malformed),
            };
            if std::mem::replace(slot, true) {
                return Err(Refusal::Malformed);
            }
        }
        found.key = parse_key(key).ok_or(Refusal::UnknownKey)?;
        found.check()?;
        Ok(found)
    }

    fn check(&self) -> Result<(), Refusal> {
        let allowed = match self.key {
            Key::Function(_) => true,
            Key::Char(character) if character.is_ascii_alphabetic() => self.primary,
            _ => self.primary || self.ctrl,
        };
        if !allowed {
            return Err(Refusal::NeedsModifier);
        }
        if RESERVED.contains(&self.canonical().as_str()) {
            return Err(Refusal::Reserved);
        }
        Ok(())
    }

    pub fn canonical(&self) -> String {
        let mut text = String::new();
        for (held, name) in [
            (self.primary, "CmdOrCtrl"),
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
        ] {
            if held {
                text.push_str(name);
                text.push('+');
            }
        }
        match self.key {
            Key::Char(character) => text.push(character),
            Key::Tab => text.push_str("Tab"),
            Key::Left => text.push_str("Left"),
            Key::Right => text.push_str("Right"),
            Key::Up => text.push_str("Up"),
            Key::Down => text.push_str("Down"),
            Key::Function(number) => text.push_str(&format!("F{number}")),
        }
        text
    }
}

pub fn action_ids() -> Vec<String> {
    let mut ids: Vec<String> = [
        MENU_CLOSE_TAB,
        MENU_NEXT_TAB,
        MENU_PREVIOUS_TAB,
        MENU_SPLIT_TAB,
        MENU_MOVE_TAB,
        MENU_CLOSE_PANE,
        MENU_FOCUS_NEXT_PANE,
    ]
    .map(str::to_owned)
    .to_vec();
    ids.extend((1..=9).map(menu_select_id));
    ids
}

fn default_for(id: &str) -> String {
    match id {
        MENU_CLOSE_TAB => "CmdOrCtrl+W".to_owned(),
        MENU_NEXT_TAB => "Ctrl+Tab".to_owned(),
        MENU_PREVIOUS_TAB => "Ctrl+Shift+Tab".to_owned(),
        MENU_SPLIT_TAB => "CmdOrCtrl+\\".to_owned(),
        MENU_MOVE_TAB => "CmdOrCtrl+Alt+\\".to_owned(),
        MENU_CLOSE_PANE => "CmdOrCtrl+Shift+\\".to_owned(),
        MENU_FOCUS_NEXT_PANE => "CmdOrCtrl+Alt+Right".to_owned(),
        other => format!("CmdOrCtrl+{}", other.rsplit('-').next().unwrap_or_default()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keybindings {
    bound: Vec<(String, String)>,
}

impl Keybindings {
    pub fn defaults() -> Self {
        Self {
            bound: action_ids()
                .into_iter()
                .map(|id| {
                    let accelerator = default_for(&id);
                    (id, accelerator)
                })
                .collect(),
        }
    }

    pub fn resolve(contents: Option<&[u8]>) -> Self {
        let mut resolved = Self::defaults();
        let Some(entries) = contents.and_then(overrides) else {
            return resolved;
        };
        let mut chosen: Vec<Option<String>> = resolved
            .bound
            .iter()
            .map(|(id, _)| {
                let text = entries.get(id.as_str())?.as_str()?;
                Accelerator::parse(text).ok().map(|found| found.canonical())
            })
            .collect();
        loop {
            let finals: Vec<&str> = resolved
                .bound
                .iter()
                .zip(&chosen)
                .map(|((_, default), choice)| choice.as_deref().unwrap_or(default))
                .collect();
            let clashing: Vec<usize> = (0..finals.len())
                .filter(|&index| {
                    chosen[index].is_some()
                        && (0..finals.len())
                            .any(|other| other != index && finals[other] == finals[index])
                })
                .collect();
            if clashing.is_empty() {
                break;
            }
            for index in clashing {
                chosen[index] = None;
            }
        }
        for ((_, accelerator), choice) in resolved.bound.iter_mut().zip(chosen) {
            if let Some(text) = choice {
                *accelerator = text;
            }
        }
        resolved
    }

    pub fn accelerator(&self, id: &str) -> Option<&str> {
        self.bound
            .iter()
            .find(|(name, _)| name == id)
            .map(|(_, accelerator)| accelerator.as_str())
    }

    pub fn entries(&self) -> &[(String, String)] {
        &self.bound
    }
}

fn overrides(bytes: &[u8]) -> Option<serde_json::Map<String, Value>> {
    let file: Value = serde_json::from_slice(bytes).ok()?;
    if file.get("v")?.as_u64()? != VERSION {
        return None;
    }
    file.get("keybindings")?.as_object().cloned()
}

pub fn read(files: &impl FileStore) -> Keybindings {
    Keybindings::resolve(files.read(FILE_NAME).ok().flatten().as_deref())
}
