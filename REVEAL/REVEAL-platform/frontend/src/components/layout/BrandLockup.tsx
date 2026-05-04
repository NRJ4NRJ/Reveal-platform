import Image from "next/image";
import Link from "next/link";

export function BrandLockup({
  href = "/dashboard",
  compact = false,
  onDark = false,
}: {
  href?: string;
  compact?: boolean;
  /** Pass true when the lockup sits over a permanently dark hero image (e.g. login page) */
  onDark?: boolean;
}) {
  const w = compact ? 112 : 144;
  const h = compact ? 34 : 40;
  const cls = compact ? "h-auto w-[112px]" : "h-auto w-[144px]";

  return (
    <Link href={href} className={`inline-flex items-center ${compact ? "gap-2 lg:gap-2 xl:gap-3" : "gap-3"}`}>
      {onDark ? (
        /* Always white logo — used on hero-image backgrounds */
        <Image src="/brand/dolfines_logo_white.png" alt="Dolfines" width={w} height={h} priority className={cls} />
      ) : (
        <>
          {/* Dark mode: white logo */}
          <Image src="/brand/dolfines_logo_white.png" alt="Dolfines" width={w} height={h} priority className={`${cls} logo-dark-only`} />
          {/* Light mode: colour logo */}
          <Image src="/brand/dolfines_colour.png" alt="Dolfines" width={w} height={h} priority className={`${cls} logo-light-only`} />
        </>
      )}
      <span
        className={`font-dolfines font-semibold ${compact ? "text-base tracking-[0.1em] xl:text-lg xl:tracking-[0.14em]" : "text-lg tracking-[0.14em]"} ${
          onDark ? "text-white" : "brand-text"
        }`}
      >
        REVEAL
      </span>
    </Link>
  );
}
