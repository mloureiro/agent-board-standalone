#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    CloseTab,
    Select(u8),
    Next,
    Previous,
    SplitTab,
    MoveTab,
    ClosePane,
    FocusNextPane,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Key<'a> {
    pub key: &'a str,
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub repeat: bool,
}

pub const MENU_CLOSE_TAB: &str = "close-tab";
pub const MENU_NEXT_TAB: &str = "tab-next";
pub const MENU_PREVIOUS_TAB: &str = "tab-previous";
pub const MENU_SPLIT_TAB: &str = "split-tab";
pub const MENU_MOVE_TAB: &str = "move-tab";
pub const MENU_CLOSE_PANE: &str = "close-pane";
pub const MENU_FOCUS_NEXT_PANE: &str = "focus-next-pane";
const MENU_SELECT_PREFIX: &str = "tab-select-";

pub fn menu_select_id(position: u8) -> String {
    format!("{MENU_SELECT_PREFIX}{position}")
}

pub fn from_menu_id(id: &str) -> Option<Action> {
    let fixed = [
        (MENU_CLOSE_TAB, Action::CloseTab),
        (MENU_NEXT_TAB, Action::Next),
        (MENU_PREVIOUS_TAB, Action::Previous),
        (MENU_SPLIT_TAB, Action::SplitTab),
        (MENU_MOVE_TAB, Action::MoveTab),
        (MENU_CLOSE_PANE, Action::ClosePane),
        (MENU_FOCUS_NEXT_PANE, Action::FocusNextPane),
    ];
    if let Some((_, action)) = fixed.iter().find(|(name, _)| *name == id) {
        return Some(*action);
    }
    let position: u8 = id.strip_prefix(MENU_SELECT_PREFIX)?.parse().ok()?;
    (1..=9)
        .contains(&position)
        .then_some(Action::Select(position))
}

pub fn from_key(key: &Key) -> Option<Action> {
    if key.repeat || key.alt {
        return None;
    }
    let meta_only = key.meta && !key.ctrl && !key.shift;
    let ctrl_only = key.ctrl && !key.meta;
    if meta_only && key.key.eq_ignore_ascii_case("w") {
        return Some(Action::CloseTab);
    }
    if meta_only {
        let position: u8 = key.key.parse().ok()?;
        return (key.key.len() == 1 && (1..=9).contains(&position))
            .then_some(Action::Select(position));
    }
    if ctrl_only && key.key == "Tab" {
        return Some(if key.shift {
            Action::Previous
        } else {
            Action::Next
        });
    }
    None
}
