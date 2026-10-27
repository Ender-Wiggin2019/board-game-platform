import './BrandWordmark.css';

export function BrandWordmark({
  children,
  size = 'navigation',
}: {
  children: string;
  size?: 'navigation' | 'heading';
}): React.JSX.Element {
  const starIndex = children.indexOf('星');

  return (
    <span className='brand-wordmark' data-size={size}>
      {starIndex < 0 ? (
        children
      ) : (
        <>
          {children.slice(0, starIndex)}
          <span className='brand-wordmark__star'>{children[starIndex]}</span>
          {children.slice(starIndex + 1)}
        </>
      )}
    </span>
  );
}
