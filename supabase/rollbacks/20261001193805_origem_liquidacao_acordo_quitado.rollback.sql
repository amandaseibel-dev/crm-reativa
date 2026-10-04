-- ============================================================================
-- ROLLBACK de 20261001193805 -- proveniencia da quitacao por acordo.
-- ============================================================================
-- Desfaz o patch ancorado em titulo_reavaliar (para de gravar a trinca) e
-- devolve o constraint ao vocabulario antigo.
--
-- ORDEM OBRIGATORIA: primeiro limpar as marcas ACORDO_QUITADO que ja existirem,
-- senao o constraint estreitado falha com 23514. A limpeza NAO mexe em situacao
-- nem em status: so apaga a marca de proveniencia.
--
-- Depois deste rollback, titulo_reabrir_quitacao_por_acordo (etapa 3) deixa de
-- ter como funcionar -- a guarda G2 dela exige a marca. Rode o rollback da
-- etapa 3 tambem, ou aceite que a porta passa a recusar tudo.
-- ============================================================================

begin;

-- 1) devolve o corpo de titulo_reavaliar ao de producao de 01/10/2026
--    (md5(prosrc) = efdf3fd198a56198223ade82e4991d40, 5625 bytes)
do $$
declare
  v_src text;
  v_troca text := $troca$    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           origem_liquidacao     = coalesce(origem_liquidacao, 'ACORDO_QUITADO'),
           origem_liquidacao_ref = coalesce(origem_liquidacao_ref, v_acordo::text),
           origem_liquidacao_em  = coalesce(origem_liquidacao_em, now()),$troca$;
  v_ancora text := $ancora$    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,$ancora$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'titulo_reavaliar'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo uuid';
  if v_src is null then raise exception 'titulo_reavaliar(uuid) nao encontrada'; end if;
  if position(v_troca in v_src) = 0 then
    raise notice 'titulo_reavaliar ja esta sem a proveniencia -- nada a fazer';
    return;
  end if;
  execute replace(v_src, v_troca, v_ancora);
end $$;

-- 2) apaga as marcas ACORDO_QUITADO, sem tocar situacao/status
update public.acordos_titulos
   set origem_liquidacao = null, origem_liquidacao_ref = null, origem_liquidacao_em = null
 where origem_liquidacao = 'ACORDO_QUITADO';

-- 3) estreita o constraint de volta
alter table public.acordos_titulos
  drop constraint if exists acordos_titulos_origem_liquidacao_valida;
alter table public.acordos_titulos
  add constraint acordos_titulos_origem_liquidacao_valida
  check (origem_liquidacao is null or origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL');

commit;
