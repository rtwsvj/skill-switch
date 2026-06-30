// shadcn/ui Button — 基于 Radix Slot,支持 variant + size CVA。
// 用法: <Button variant="default|outline|ghost|destructive|secondary" size="sm|md|lg|icon">
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  // 基础样式:覆盖全局 button reset
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ' +
  'disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // 主色实心按钮
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        // 危险/删除
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        // 描边
        outline: 'border border-border bg-card shadow-sm hover:bg-accent hover:text-accent-foreground',
        // 次要
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        // 幽灵(无背景)
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // 纯文字链接
        link: 'text-primary underline-offset-4 hover:underline',
        // 语义:成功/完成操作
        good: 'border border-good/65 text-good hover:bg-good/10',
        // 语义:危险操作确认
        danger: 'border border-danger/65 text-danger hover:bg-danger/10',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 设为 true 时将样式渲染到子元素上,不多包一层 <button> */
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';

export { Button, buttonVariants };
