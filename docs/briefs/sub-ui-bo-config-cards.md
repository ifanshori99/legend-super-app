=================== legend-woc1
◐ legend-woc1 · WS-05 FE: tax rule item/category targets, outlet-specific versions, discard draft   [P2 · IN_PROGRESS]
Created by: ifanshori99 · Type: task
Created: 2026-11-01 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  legend-efr built the tax/service-charge config screens against              
  @starter/shared/tax, but the editor covers three gaps: (1)                  
  taxAppliesTo.categoryIds/itemIds exist in the contract (PRD v1.7 §3.14      
  'Aturan Pajak Berversi' - per item or category) while the UI only edits     
  itemClasses and preserves existing targets; add a category/item multi-select
  fed by the menu contract. (2) outletId versions ('outlet version overrides  
  the tenant-wide code') are not selectable; add an outlet override selector. 
  (3) lifecycle archiveRuleVersion supports draft -> archived but no HTTP     
  endpoint exists, so a bad draft cannot be discarded; add archive draft to   
  the tax contract + API + the row action. Add mock handlers and tests for    
  each.                                                                       



NOTES

  From legend-efr review: tax settings (Opsi perhitungan) also has no PATCH   
  endpoint, so a settings draft can only be published or superseded; include  
  edit/discard for settings drafts in this bead.                              



LABELS: fe, gate-ui, ws-05

DISCOVERED FROM
  ◊ ✓ legend-efr: WS-05 FE: Tax & service charge config (versioned rules, calc options) + PBJT monthly report screen P1

COMMENTS
  2026-11-09 04:54 Ilham fadillah Anshori
    
      Audit m1 0f7e4ff6 (2026-11-09): sebagian. tax-rule-dialog.tsx:161 hanya     
      mempertahankan categoryIds; KURANG: multi-select kategori/item, selector    
      outlet, endpoint archive draft.                                             
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

=================== legend-d5pz
◐ legend-d5pz · WS-05 UI: warn before switching off the only food_beverage tax rule (use 0% for exempt)   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-09 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  Switching a tax rule isActive=false makes every POS and QR line fail with   
  TAX_RULE_NOT_FOUND (calculate.ts tombstone). Exempt must be rateBp 0. In    
  apps/web/src/features/ws05-tax/components/tax-rule-dialog.tsx warn before   
  deactivating the only food_beverage rule and point to 0%. Found by architect
  review of legend-9obf.                                                      



LABELS: fe, gate-ui, ws-05

COMMENTS
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

=================== legend-j0kd
◐ legend-j0kd · Settings hub: link tenant integrations, theme, terms and config pages   [P2 · IN_PROGRESS]
Created by: ifanshori99 · Type: task
Created: 2026-11-03 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  ws11-audit hub.ts/settings-hub-page.tsx lists none of                       
  /kelola/pengaturan/{integrasi,tema,istilah,konfigurasi}; add cards gated by 
  each page guard (org.integration.manage, org.theme.manage, Super Admin for  
  istilah, org.config.export). Sidebar entry always opens /integrasi, so      
  custom roles with only theme/export hit not-found.                          



LABELS: fe, gate-ui, ws-11

DISCOVERED FROM
  ◊ ✓ legend-5k0: WS-01 FE: Tenant settings: integrations (masked credentials), Tenant Theme editor with contrast check, term dictionary (Super Admin), config export/import P1

COMMENTS
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

=================== legend-0frf
◐ legend-0frf · Menu admin UI: set station type per menu item (stationType), station override optional   [P2 · IN_PROGRESS]
Created by: ifanshori99 · Type: task
Created: 2026-11-08 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  menu item contract now has stationType (brand level, resolved per outlet)   
  and stationId as an outlet-only override. apps/web item editor (ws03-menu   
  item-editor-page, mock.ts) should let admins pick the station type; DTO     
  field is optional only for backward compatibility.                          



LABELS: gate-ui

DISCOVERED FROM
  ◊ ✓ legend-s2dh: WS-04 BE: menu station type per brand, resolved per outlet (override station_id only in its outlet) P2

COMMENTS
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

=================== legend-5ac3
◐ legend-5ac3 · WS-07 FE: outlet attribution on manual and recurring journal lines   [P2 · IN_PROGRESS]
Created by: ifanshori99 · Type: task
Created: 2026-11-01 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  The manual/recurring forms (legend-mzg) post entity-level lines (outletId   
  null) because they have no outlet picker; per-outlet P&L (ACC-03) needs     
  attribution. Add an optional outlet per line (or one outlet for the entry)  
  using GET /api/org/outlets, preserving null = entity-level. PRD §3.19, ACC- 
  03.                                                                         



LABELS: fe, gate-ui, ws-07

DISCOVERED FROM
  ◊ ✓ legend-mzg: WS-07 FE: CoA per legal entity + journal list/detail drill-down to source + manual/recurring journal with approval P1

COMMENTS
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

=================== legend-s7szu
◐ legend-s7szu · Show receiptRunAlert (repeated edge receipt run rotation) on a screen   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-09 · Started: 2026-11-11 · Updated: 2026-11-11

DESCRIPTION

  From legend-yd0h8 architect review K. receiptRunAlert/receiptRunAlertAt are 
  only in GET /api/edge/status and a cloud warn log (with edgeNodeId). No     
  dashboard/edge screen shows them. Add to the edge status UI and/or cloud    
  edge node admin view with the restore procedure text (reset                 
  edge_nodes.instance_id).                                                    



LABELS: gate-ui

COMMENTS
  2026-11-11 06:50 Ilham fadillah Anshori
    
      Gerbang mockup lolos: founder Setuju (review page Q29-Q40, 11 Nov). Nama    
      menu pakai 'Pajak & layanan' (keputusan CTO, Q30).                          

