import type { FormHTMLAttributes, ReactNode } from 'react'

/**
 * 轻量表单容器：阻止默认提交、暴露 submit 事件；
 * 校验与错误文案由调用方管理（每字段一条、整表一个主错误，PC-14）。
 */
export interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void
  children?: ReactNode
}

export function Form({ onSubmit, children, ...rest }: FormProps) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit?.(event)
      }}
      {...rest}
    >
      {children}
    </form>
  )
}
