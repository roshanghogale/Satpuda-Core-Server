// The master list check is its own app on this server (/master-review/); it is shown here, inside the
// panel, so the menu stays. Same site and same tab: it finds this tab's sign-in and the theme by itself.
export default function MasterReview() {
  return <iframe className="embed-frame" title="Master list check" src="/master-review/?embed=1" />;
}
