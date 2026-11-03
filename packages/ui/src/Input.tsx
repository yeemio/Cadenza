import { cva, type VariantProps } from 'class-variance-authority'
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

export interface FieldProps {
  /** 字段名，作为 label 的 htmlFor */
  htmlFor?: string
  label?: ReactNode
  /** 是否必填（仅控制红星标识；校验由调用方给出 error 文案，OA-12） */
  required?: boolean
  /** 校验错误文案（每字段同一时刻只展示一条，PC-14） */
  error?: ReactNode
  /** 辅助说明（如密码规则 OA-14） */
  hint?: ReactNode
  children: ReactNode
}

export function Field({ htmlFor, label, required, error, hint, children }: FieldProps) {
  return (
    <div className="mb-3.5 flex flex-col gap-1.5" data-slot="field">
      {label ? (
        <label
          className="flex items-center gap-1 text-sm font-medium text-foreground"
          htmlFor={htmlFor}
        >
          {required ? (
            <span className="text-destructive" aria-hidden>
              *
            </span>
          ) : null}
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className="text-[12.5px] leading-snug text-destructive" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="text-[12.5px] leading-snug text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  )
}

/* ---- 输入控件基类变体（CVA） ---- */
const controlVariants = cva(
  'w-full rounded-md border border-input bg-card font-sans text-foreground shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:border-border/70 disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 aria-invalid:focus-visible:border-destructive',
  {
    variants: {
      controlSize: {
        md: 'h-9 px-3 text-sm',
        lg: 'h-11 px-3.5 text-base',
      },
    },
    defaultVariants: {
      controlSize: 'md',
    },
  },
)

export interface InputProps
  extends InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof controlVariants> {
  inputSize?: 'md' | 'lg'
  invalid?: boolean
}

export function Input({ inputSize = 'md', invalid, className, ...rest }: InputProps) {
  return (
    <input
      className={cn(controlVariants({ controlSize: inputSize }), className)}
      aria-invalid={invalid || undefined}
      data-slot="input"
      {...rest}
    />
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'min-h-16 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25',
        className,
      )}
      aria-invalid={invalid || undefined}
      data-slot="textarea"
      {...rest}
    />
  )
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
  /** 选项：value + 中文标签；disabled 用于前端即时约束（如 MD-24 部门类型限制可选仓库类型） */
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  placeholder?: string
}

/**
 * 原生 select（保真迁移：DOM 结构与旧版一致，语义/键盘/表单提交及既有测试的
 * selectOptions 行为兼容），外观现代化：去系统外观 + CSS 箭头 + 焦点环
 * （箭头见 theme.css 的 .cz-select-chevron）。
 */
export function Select({ invalid, options, placeholder, className, children, ...rest }: SelectProps) {
  return (
    <select
      className={cn(controlVariants(), 'cz-select-chevron appearance-none pr-8', className)}
      aria-invalid={invalid || undefined}
      data-slot="select"
      {...rest}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} disabled={opt.disabled}>
          {opt.label}
        </option>
      ))}
      {children}
    </select>
  )
}
