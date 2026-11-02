-- The day a purchase was made (Plaid's authorized_date), next to the day it posted (date). A card
-- purchase on a quarter's last day can post the next day; ABC files a purchase, and the credit that
-- paid it back, by the day it was made, as card issuers do. Set by sync from now on; older rows
-- keep NULL (Plaid sends it with new and changed transactions only).
ALTER TABLE transactions ADD COLUMN authorized_date TEXT;
