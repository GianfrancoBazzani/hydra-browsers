/** Three decorative window buttons (spec section 10.1). They have no actions. */
export function TrafficLights() {
  return (
    <div aria-hidden="true" data-testid="traffic-lights" className="flex gap-2">
      <span className="size-3 rounded-full border-[0.5px] border-(--os-traffic-red-border) bg-(--os-traffic-red)" />
      <span className="size-3 rounded-full border-[0.5px] border-(--os-traffic-yellow-border) bg-(--os-traffic-yellow)" />
      <span className="size-3 rounded-full border-[0.5px] border-(--os-traffic-green-border) bg-(--os-traffic-green)" />
    </div>
  );
}
