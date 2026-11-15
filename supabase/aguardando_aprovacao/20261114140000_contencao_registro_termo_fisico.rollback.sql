-- REVERSÃO da contenção B1 (PENDENTE). Única alteração: contencao_ativa = false. Não recria, não apaga,
-- não altera grants (a contenção nunca alterou grants). Idempotente. Histórico preservado.
BEGIN;
do $$
begin
  if not exists (select 1 from public.termo_fisico_contencao where id) then
    raise exception 'pré-condição: linha de contenção ausente. Nada alterado.' using errcode = 'P0001';
  end if;
end $$;
update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'reversao_b1' where id;
COMMIT;
