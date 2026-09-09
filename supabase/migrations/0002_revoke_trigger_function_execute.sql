-- Trigger-Funktionen gehören nicht in die öffentliche API.
--
-- Gefunden vom Supabase-Security-Linter nach dem ersten Deploy
-- (0028/0029_*_security_definer_function_executable).
--
-- `handle_new_user()` läuft als SECURITY DEFINER, damit sie beim Registrieren
-- in public.profiles und public.settings schreiben darf. PostgREST macht aber
-- jede Funktion im public-Schema auch als /rest/v1/rpc/... erreichbar — damit
-- konnten anon und authenticated sie direkt aufrufen.
--
-- Ein direkter Aufruf würde scheitern (eine Trigger-Funktion ohne
-- Trigger-Kontext bricht ab), aber eine SECURITY-DEFINER-Funktion gehört
-- grundsätzlich nicht in die Angriffsfläche. Der Trigger selbst läuft
-- unabhängig von diesen EXECUTE-Rechten weiter, weil er im Kontext der
-- Tabelle feuert und nicht über die API aufgerufen wird.

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
