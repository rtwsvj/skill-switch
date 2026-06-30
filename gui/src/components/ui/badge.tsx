// shadcn/ui Badge — 小标签/状态标记。
// 用法: <Badge variant="default|secondary|outline|destructive|good|warn|danger">文字</Badge>
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ' +
  'transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ' +
  'font-console whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground',
        // 语义扩展
        good: 'border-good/50 text-good',
        warn: 'border-warn/65 text-warn',
        danger: 'border-danger/65 text-danger',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
