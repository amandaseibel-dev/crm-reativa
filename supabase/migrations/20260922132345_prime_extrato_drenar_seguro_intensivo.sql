-- FECHAMENTO DO ESTOQUE DO GRUPO B, SEM SQL MANUAL, SEM SOBREPOSICAO, AUTODESLIGAVEL.
--
-- Nao muda a busca no Prime nem o consumo (continua sendo public.prime_extrato_mutirao(), a mesma funcao
-- oficial, mesmo teto de 110s, mesma concorrencia 16, mesmo retry 503 -- nenhum caminho paralelo). So
-- acrescenta uma casca de seguranca: `prime_extrato_drenar_seguro()`.
--
--  1. Trava por advisory lock (nao bloqueante): impede que a drenagem normal e a intensiva rodem ao mesmo
--     tempo uma da outra, e impede que a intensiva sobreponha a si mesma se uma chamada ainda estiver em
--     voo quando a proxima disparar.
--  2. Antes de chamar o mutirao, mede quanto falta do universo do grupo B (pendente_vinculo_diario, ainda
--     nao coletado, tentativas<3). Se zerou, DESLIGA SOZINHA o job intensivo (cron.unschedule) e nao chama
--     o mutirao por essa via -- a cadencia normal (3x/dia) continua ativa para sempre, sem depender de
--     ninguem lembrar de desligar nada.
--  3. Se ainda falta, chama public.prime_extrato_mutirao() uma vez (mesmo contrato de sempre).
--
-- RETRY DE FALHA TRANSITORIA (503/timeout): ja e automatico sem mudanca nenhuma aqui -- o enfileirador
-- diario (20260922230000) roda 1x/dia e RESETA tentativas/coletado_em de qualquer aluno que ainda esteja
-- no universo do grupo B, inclusive quem bateu tentativas>=3 e saiu do radar do mutirao. Isso ja cobre
-- "caso nao perdido, retry automatico, sem duplicacao (PK matricula), idempotente, com erro auditado
-- (ultimo_erro)".
--
-- ESTOQUE RETROATIVO E NOVAS ENTRADAS: ja cobertos sem mudanca -- o enfileirador nao filtra por data; ele
-- relê `acordos`/`acordos_titulos`/`acordo_titulo_vinculo` inteiros todo dia, entao acordo antigo ou novo
-- caem no mesmo universo automaticamente. O job de vinculo (15 min, ja em producao) reavalia tudo do zero
-- a cada rodada -- qualquer evidencia nova (FORTE) e absorvida sem depender desta migration.
begin;

create or replace function public.prime_extrato_drenar_seguro()
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_pend int; v_res jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('prime_extrato_drenar_seguro')) then
    return jsonb_build_object('ok', true, 'pulou', 'EM_EXECUCAO');
  end if;

  select count(*) into v_pend from public.prime_extrato_fila
   where motivo = 'pendente_vinculo_diario' and coletado_em is null and tentativas < 3;

  if coalesce(v_pend, 0) = 0 then
    if exists (select 1 from cron.job where jobname = 'prime_extrato_pendentes_vinculo_intensivo') then
      perform cron.unschedule('prime_extrato_pendentes_vinculo_intensivo');
    end if;
    return jsonb_build_object('ok', true, 'pulou', 'SEM_BACKLOG_GRUPO_B');
  end if;

  v_res := public.prime_extrato_mutirao();
  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('pendentes_grupo_b_antes', v_pend);
end;
$function$;

revoke all on function public.prime_extrato_drenar_seguro() from public, anon, authenticated;
grant execute on function public.prime_extrato_drenar_seguro() to service_role;

-- a drenagem normal (3x/dia) passa a usar a mesma trava/checagem, sem mudar horario nem cadencia
select cron.schedule('prime_extrato_pendentes_vinculo_drenar', '15,35,55 3 * * *',
  $cron$select public.prime_extrato_drenar_seguro();$cron$);

-- modo intensivo TEMPORARIO: a cada 3 min, o dia inteiro; se desligar sozinho quando o backlog do grupo B
-- zerar (ver funcao acima). Nao depende de ninguem voltar para remover este job.
select cron.schedule('prime_extrato_pendentes_vinculo_intensivo', '*/3 * * * *',
  $cron$select public.prime_extrato_drenar_seguro();$cron$);

commit;
