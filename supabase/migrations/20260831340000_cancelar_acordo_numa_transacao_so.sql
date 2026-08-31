-- Cancelar acordo vira UMA operacao, na ordem certa.
--
-- Amanda, 31/08: "ta criando parcela ainda" -- na ficha da Jaqueline da Silva
-- de Aguiar aparecia um boleto de R$ 1.540,94 de um acordo que ela tinha
-- acabado de cancelar, e a parcela do mesmo valor junto.
--
-- CAUSA. A tela cancelava o acordo com updates soltos, sem transacao e sem
-- checar erro (mesmo padrao de "Quitar tudo gravava pela metade"):
--
--   1. delete  acordo_titulo_vinculo
--   2. update  acordos_titulos  status='em_aberto'
--   3. update  parcelas         status='CANCELADA'   <- erro NAO conferido
--   4. update  acordos          status='CANCELADO'
--
-- Dois furos nisso:
--
-- (a) O passo 1 apaga o vinculo ANTES do passo 4. Mas o gatilho
--     titulos_por_status_acordo, que dispara no passo 4, le exatamente
--     acordo_titulo_vinculo para saber o que devolver -- ele acorda cego. Por
--     isso o boleto do proprio acordo nunca ia para CANCELADA e seguia como
--     divida viva. Medido: 18 titulos tipo_boleto='Acordo' em aberto sem
--     nenhum vinculo, R$ 32.758,19.
--
-- (b) O passo 3 nao confere erro. Falhando (RLS ou o timeout de 8s do
--     PostgREST), o codigo seguia e cancelava o acordo do mesmo jeito --
--     acordo morto com parcela viva. O job diario atualizar_parcelas_vencidas
--     entao marcava A_VENCER -> VENCIDA, sem olhar o status do acordo, e a
--     parcela reaparecia como divida. Medido: 175 parcelas em 68 acordos,
--     R$ 94.628,77, todas de agosto/2026.
--
-- A RPC faz tudo numa transacao e na ordem que o gatilho precisa: o acordo
-- muda de status PRIMEIRO (vinculo ainda no lugar), depois as parcelas, so
-- entao o vinculo sai -- desativado, nao apagado, para o rastro do que o
-- acordo cobria nao se perder de novo -- e o recalculo por ULTIMO.
--
-- BACKFILL executado em 31/08 (backups: _backup_parcela_viva_acordo_cancelado_20260831
-- e _backup_boleto_acordo_orfao_20260831):
--   169 parcelas canceladas em 65 acordos, R$ 85.842,06. Cada uma so depois de
--   provar que a divida esta representada de outro jeito -- mensalidade em
--   aberto cobrindo o valor, ou acordo ATIVO substituindo.
--   6 parcelas em 3 acordos (R$ 8.786,71) ficaram de fora: nada representa
--   essa divida, decisao da Amanda.
--   12 boletos de acordo cancelados, R$ 26.462,73, todos com acordo de mesmo
--   valor ja CANCELADO ou QUITADO (somando por boleto, nao por titulo: os
--   documentos terminados em 0001..0007 sao parcelas do mesmo boleto).
--   2 ficaram de pe (Claudia Endres Leal, Kelly Cristina Neis de Borba): o
--   acordo de mesmo valor esta ATIVO, o boleto e divida legitima.
--   4 em quarentena (R$ 5.728,89): nenhum acordo bate com o valor.

create or replace function public.acordo_cancelar(
  p_acordo_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_aluno_id uuid;
  v_status text;
  v_parcelas int := 0;
  v_devolvidos int := 0;
  v_boleto_cancelado int := 0;
  v_vinculos int := 0;
begin
  select a.aluno_id, upper(coalesce(a.status,''))
    into v_aluno_id, v_status
    from public.acordos a where a.id = p_acordo_id
   for update;

  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0002';
  end if;
  if v_status = 'CANCELADO' then
    return jsonb_build_object('ok', true, 'ja_estava_cancelado', true);
  end if;
  if v_status = 'QUITADO' then
    raise exception 'Acordo ja esta QUITADO -- nao pode ser cancelado.' using errcode = '22000';
  end if;

  -- 1) o acordo muda de status PRIMEIRO, com o vinculo ainda no lugar.
  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = now()
   where id = p_acordo_id;

  -- 2) titulos que o gatilho devolveu ficam com o status coerente
  update public.acordos_titulos t
     set status = 'em_aberto', atualizado_em = now()
    from public.acordo_titulo_vinculo v
   where v.titulo_id = t.id and v.acordo_id = p_acordo_id and coalesce(v.ativo, true)
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and coalesce(t.status,'') <> 'em_aberto';
  get diagnostics v_devolvidos = row_count;

  select count(*) into v_boleto_cancelado
    from public.acordos_titulos t
    join public.acordo_titulo_vinculo v on v.titulo_id = t.id
   where v.acordo_id = p_acordo_id and coalesce(t.tipo_boleto,'') = 'Acordo'
     and upper(coalesce(t.situacao,'')) = 'CANCELADA';

  -- 3) as parcelas do acordo morto param de contar.
  update public.parcelas
     set status = 'CANCELADA', atualizado_em = now()
   where acordo_id = p_acordo_id and status <> 'PAGO' and status <> 'CANCELADA';
  get diagnostics v_parcelas = row_count;

  -- 4) so agora o vinculo sai -- desativado, nao apagado.
  update public.acordo_titulo_vinculo
     set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  -- 5) recalculo por ULTIMO, com tudo ja escrito.
  perform public.recalcular_situacao_aluno(v_aluno_id);

  return jsonb_build_object(
    'ok', true,
    'aluno_id', v_aluno_id,
    'parcelas_canceladas', v_parcelas,
    'titulos_devolvidos', v_devolvidos,
    'vinculos_desativados', v_vinculos,
    'boleto_do_acordo_cancelado', v_boleto_cancelado
  );
end;
$function$;

revoke all on function public.acordo_cancelar(uuid, text) from public, anon;
grant execute on function public.acordo_cancelar(uuid, text) to authenticated, service_role;
