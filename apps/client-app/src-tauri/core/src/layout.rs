pub const TAB_BAR_HEIGHT: f64 = 36.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn strip(height: f64) -> f64 {
    TAB_BAR_HEIGHT.min(height).max(0.0)
}

pub fn tab_bar(width: f64, height: f64) -> Bounds {
    Bounds {
        x: 0.0,
        y: 0.0,
        width,
        height: strip(height),
    }
}

pub fn page(width: f64, height: f64) -> Bounds {
    let bar = strip(height);
    Bounds {
        x: 0.0,
        y: bar,
        width,
        height: (height - bar).max(0.0),
    }
}

pub fn pane_page(width: f64, height: f64, split: &[f64], pane: usize) -> Bounds {
    let full = page(width, height);
    let start = if pane == 0 {
        0.0
    } else {
        split.get(pane - 1).copied().unwrap_or(1.0)
    };
    let end = split.get(pane).copied().unwrap_or(1.0);
    Bounds {
        x: start * width,
        width: (end - start).max(0.0) * width,
        ..full
    }
}
