/**
 * Toast primitives — a dependency-free implementation with the shadcn API
 * surface the app already uses (Toast / ToastClose / ToastTitle / …).
 *
 * The template this replaced rendered plain <div>s that ignored `open`,
 * `onOpenChange` and `duration`, and a close <button> with no handler — so
 * toasts could neither auto-dismiss nor be closed, and only vanished on a
 * page refresh. This version honours all three: a toast closes itself after
 * `duration` (5s, 8s for destructive), the X closes it, and a closed toast
 * unmounts.
 */
import * as React from "react";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const ToastContext = React.createContext({ close: () => {} });

const ToastProvider = ({ children }) => <>{children}</>;
ToastProvider.displayName = "ToastProvider";

/** Top-right on desktop, top-center stack on small screens. */
const ToastViewport = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 md:max-w-[420px]",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = "ToastViewport";

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all animate-in fade-in-0 slide-in-from-top-2 sm:slide-in-from-right-full",
  {
    variants: {
      variant: {
        default: "border bg-background text-foreground",
        destructive:
          "destructive group border-destructive bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const Toast = React.forwardRef(
  ({ className, variant, open = true, onOpenChange, duration, ...props }, ref) => {
    const close = React.useCallback(() => onOpenChange?.(false), [onOpenChange]);
    const ms = duration ?? (variant === "destructive" ? 8000 : 5000);

    React.useEffect(() => {
      if (!open || ms === Infinity) return undefined;
      const t = setTimeout(close, ms);
      return () => clearTimeout(t);
    }, [open, ms, close]);

    if (!open) return null;

    return (
      <ToastContext.Provider value={{ close }}>
        <div
          ref={ref}
          role="status"
          aria-live="polite"
          data-state="open"
          className={cn(toastVariants({ variant }), className)}
          {...props}
        />
      </ToastContext.Provider>
    );
  }
);
Toast.displayName = "Toast";

const ToastAction = React.forwardRef(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive",
      className
    )}
    {...props}
  />
));
ToastAction.displayName = "ToastAction";

const ToastClose = React.forwardRef(({ className, onClick, ...props }, ref) => {
  const { close } = React.useContext(ToastContext);
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Dismiss notification"
      className={cn(
        "absolute right-2 top-2 rounded-md p-1 text-foreground/60 transition-opacity hover:text-foreground focus:outline-none focus:ring-2 group-[.destructive]:text-red-200 group-[.destructive]:hover:text-red-50 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600",
        className
      )}
      onClick={(e) => { onClick?.(e); close(); }}
      {...props}
    >
      <X className="h-4 w-4" />
    </button>
  );
});
ToastClose.displayName = "ToastClose";

const ToastTitle = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
ToastTitle.displayName = "ToastTitle";

const ToastDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm opacity-90", className)} {...props} />
));
ToastDescription.displayName = "ToastDescription";

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
  toastVariants,
};
