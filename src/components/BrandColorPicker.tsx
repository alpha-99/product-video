"use client";

/**
 * 创作向导第 4 步「品牌色」选择器（验收整改）。
 *
 * 产品规则：
 * - 主路径是点选（预设色板 + 系统取色器），用户不需要理解色值格式；
 * - HEX / RGB 手输属于「高级玩法」，默认折叠在原生 details 里；
 * - 只有规范化后的 #rrggbb 能写入 value；非法输入只提示、不生效，
 *   杜绝「预览变了色、提交却被后端拒绝」的所见非所得；
 * - 草稿与错误状态由父组件持有，切换向导步骤不会丢失用户输入。
 */
import { Field } from "./ui";
import {
  BRAND_SWATCHES, DEFAULT_PICKER_COLOR, hexToRgbLabel, normalizeHex,
} from "../lib/client/color";

interface BrandColorPickerProps {
  /** 已生效的规范化色值（#rrggbb）或空串（= 模板默认配色）。 */
  value: string;
  /** 高级手输区草稿，允许是任意中间态。 */
  draft: string;
  /** 草稿校验失败原因；非空时父组件应阻止继续下一步。 */
  error: string | null;
  onPick: (hex: string) => void;
  onDraftChange: (raw: string) => void;
  onClear: () => void;
}

export function BrandColorPicker({
  value, draft, error, onPick, onDraftChange, onClear,
}: BrandColorPickerProps) {
  // input[type=color] 只接受合法 6 位 HEX；空值时给一个可见的起始色。
  const pickerValue = normalizeHex(value) ?? DEFAULT_PICKER_COLOR;
  const selected = value.toLowerCase();

  return (
    <div className="color-picker">
      <div className="color-current">
        <span
          className="color-chip"
          style={value ? { background: value } : undefined}
          data-empty={!value}
          aria-hidden="true"
        />
        <div className="color-meta">
          <b>{value ? value.toUpperCase() : "使用模板默认配色"}</b>
          <span>{value ? hexToRgbLabel(value) : "留空时按所选模板的默认品牌色渲染"}</span>
        </div>
        {value && (
          <button type="button" className="color-clear" onClick={onClear}>
            恢复默认
          </button>
        )}
      </div>

      <div className="color-section">
        <span className="color-label" id="brand-swatch-label">快速选色</span>
        <div className="color-swatches" role="group" aria-labelledby="brand-swatch-label">
          {BRAND_SWATCHES.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              className={`color-swatch${selected === swatch.hex ? " selected" : ""}`}
              style={{ background: swatch.hex }}
              aria-label={`${swatch.label} ${swatch.hex}`}
              aria-pressed={selected === swatch.hex}
              title={`${swatch.label} ${swatch.hex}`}
              onClick={() => onPick(swatch.hex)}
            />
          ))}
        </div>
        <label className="color-custom">
          <input
            type="color"
            value={pickerValue}
            onChange={(event) => onPick(event.target.value)}
            aria-label="自定义取色"
          />
          <span>自定义取色 · 点击色块打开系统取色器</span>
        </label>
      </div>

      <details className="color-advanced">
        <summary>高级：手动输入色值（HEX / RGB）</summary>
        <div className="color-advanced-body">
          <Field
            label="色值"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="#1f4d3d 或 rgb(31, 77, 61)"
            error={error ?? undefined}
            hint="支持 #RRGGBB、#RGB、rgb(31,77,61)、31,77,61；留空使用模板默认"
          />
          <p className="muted">
            输入合法值即刻生效，并同步上方色板与右侧预览；非法值不会写入，也不影响已选颜色。
          </p>
        </div>
      </details>
    </div>
  );
}
