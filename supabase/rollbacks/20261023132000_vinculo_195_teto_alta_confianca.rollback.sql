-- ============================================================================
-- ROLLBACK: o vinculo pelo Prime 195 volta ao comportamento de antes de
-- 23/10/2026.
--
-- EFEITO, dito sem suavizar:
--
--   1. Acordo QUITADO volta a poder ser FORTE. Os 11 de hoje (R$ 3.522,89)
--      voltam a oferecer o botao de um clique -- e naquele caminho vincular
--      QUITA a mensalidade (`situacao='PAGO'`, `status='quitada'`) por
--      inferencia de janela de data, sem pagamento comprovado daquela
--      mensalidade.
--   2. Acordo ATIVO sem parcela viva volta a poder ser vinculado, pela tela e
--      por qualquer um dos seis chamadores da RPC. Vincular passa a poder tirar
--      a mensalidade do saldo sem nada entrar no lugar -- o furo que em
--      24/09/2026 fez R$ 24.460,12 desaparecerem da cobranca. Sao 4 acordos
--      ATIVO em producao nessa condicao.
--   3. A tela volta a dizer so "nao e forte" em vez de nomear a regra que
--      barrou.
--
-- O QUE A VOLTA *NAO* FAZ: nao desfaz vinculo nenhum. Os 76 registros de
-- decisao e os vinculos ja criados ficam exatamente como estao -- a ida nunca
-- os tocou. ZERO DML nas duas direcoes: nenhum pagamento, acordo, parcela,
-- baixa, status, saldo ou etapa de `fluxo_pagamentos_config` e alterado.
--
-- COMO A VOLTA E FEITA: remocao do texto que a ida inseriu, sobre
-- `pg_get_functiondef` -- o espelho exato do patch ancorado. Se o texto novo
-- nao estiver la, o bloco nao faz nada (idempotente); se estiver e a remocao
-- nao mudar nada, ABORTA em vez de deixar meia-volta.
-- ============================================================================

-- 1 e 2. O calculo do nivel volta a FORTE = um grupo na janela, sem concorrente.
do $volta_nivel$
declare
  v_src  text := pg_get_functiondef('public.acordo_vinculo_sugestoes_calcular(uuid)'::regprocedure);
  v_novo text;
begin
  if position('ACORDO_SEM_PARCELA_VIVA' in v_src) = 0 then
    raise notice 'nivel: ida nao esta aplicada, nada a desfazer';
    return;
  end if;

  v_novo := replace(v_src,
    ',' || chr(10) ||
    '           (select count(*) from public.parcelas p' || chr(10) ||
    '             where p.acordo_id = ac.id and public.parcela_viva(p.status))::int parc_vivas', '');

  v_novo := replace(v_novo,
    'case when r.ng_win = 0 then ''SEM_EVIDENCIA''' || chr(10) ||
    '              when r.ng_win = 1 and not r.tem_conc and r.st = ''ATIVO'' and r.parc_vivas > 0' || chr(10) ||
    '                then ''FORTE''' || chr(10) ||
    '              else ''REVISAO'' end',
    'case when r.ng_win = 0 then ''SEM_EVIDENCIA'' when r.ng_win = 1 and not r.tem_conc then ''FORTE'' else ''REVISAO'' end');

  v_novo := replace(v_novo,
    chr(10) ||
    '              when r.st <> ''ATIVO'' then ''ACORDO_QUITADO_EXIGE_REVISAO''' || chr(10) ||
    '              when r.parc_vivas = 0 then ''ACORDO_SEM_PARCELA_VIVA''', '');

  if v_novo = v_src then
    raise exception 'vinculo 195 rollback: nada foi removido do calculo do nivel.';
  end if;
  if position('parc_vivas' in v_novo) > 0 then
    raise exception 'vinculo 195 rollback: sobrou referencia a parc_vivas -- a funcao ficaria invalida.';
  end if;
  execute v_novo;
end
$volta_nivel$;

-- 3. A RPC compartilhada volta a nao exigir parcela viva.
do $volta_rpc$
declare
  v_src  text := pg_get_functiondef('public.vincular_titulos_acordo(uuid[], uuid)'::regprocedure);
  v_novo text;
  v_bloco text;
begin
  if position('ACORDO_ATIVO_SEM_PARCELA_VIVA' in v_src) = 0 then
    raise notice 'rpc: ida nao esta aplicada, nada a desfazer';
    return;
  end if;

  v_bloco :=
    chr(10) || chr(10) ||
    '  -- 23/10/2026: ACORDO ATIVO TEM DE TER PARCELA VIVA.' || chr(10) ||
    '  -- Vincular tira a mensalidade do saldo (recalcular_situacao_aluno exclui' || chr(10) ||
    '  -- titulo com vinculo ativo a acordo nao cancelado e nao quitado). Se o' || chr(10) ||
    '  -- acordo ATIVO nao tem parcela viva, nada entra no lugar e a divida sai da' || chr(10) ||
    '  -- cobranca sem ninguem decidir isso -- o mesmo furo dos R$ 24.460,12 de' || chr(10) ||
    '  -- 24/09/2026. QUITADO fica FORA desta trava: la o ramo v_quitado quita a' || chr(10) ||
    '  -- mensalidade porque o pagamento existe, e e por esse caminho que a' || chr(10) ||
    '  -- recuperacao do acordo a vista funciona.' || chr(10) ||
    '  if v_status_acordo = ''ATIVO''' || chr(10) ||
    '     and not exists (select 1 from public.parcelas p' || chr(10) ||
    '                      where p.acordo_id = p_acordo_id and public.parcela_viva(p.status)) then' || chr(10) ||
    '    return jsonb_build_object(''ok'', false, ''erro'', ''ACORDO_ATIVO_SEM_PARCELA_VIVA'',' || chr(10) ||
    '      ''detalhe'', ''o acordo esta ATIVO e nao tem parcela viva: vincular tiraria a ''' || chr(10) ||
    '                  ''mensalidade do saldo sem nada entrar no lugar'');' || chr(10) ||
    '  end if;';

  v_novo := replace(v_src, v_bloco, '');
  if v_novo = v_src then
    raise exception 'vinculo 195 rollback: o bloco da RPC nao foi encontrado para remocao.';
  end if;
  if position('ACORDO_ATIVO_SEM_PARCELA_VIVA' in v_novo) > 0 then
    raise exception 'vinculo 195 rollback: sobrou a trava na RPC.';
  end if;
  execute v_novo;
end
$volta_rpc$;

-- 4. A porta da tela volta ao corpo anterior, VERBATIM de producao em
--    23/10/2026 (md5 do prosrc conferido antes de escrever este arquivo).
create or replace function public.acordo_vinculo_sugestao_confirmar(
  p_acordo_id uuid, p_composicao_hash text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare v_email text := lower(coalesce(auth.email(),'')); s record; v_ids uuid[]; v_res jsonb;
begin
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: somente gestao.' using errcode = '42501'; end if;
  if v_email = '' then return jsonb_build_object('ok', false, 'erro', 'NAO_AUTENTICADO'); end if;
  select * into s from public.acordo_vinculo_sugestoes_calcular(p_acordo_id);
  if not found then return jsonb_build_object('ok', false, 'erro', 'ACORDO_NAO_ELEGIVEL'); end if;
  if s.nivel <> 'FORTE' then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_NAO_E_FORTE', 'nivel', s.nivel, 'motivo', s.motivo);
  end if;
  if s.composicao_hash is distinct from p_composicao_hash then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_MUDOU', 'composicao_atual', s.composicao_hash);
  end if;
  select array_agg((x->>'titulo_id')::uuid order by (x->>'titulo_id')::uuid) into v_ids from jsonb_array_elements(s.titulos) x;
  v_res := public.vincular_titulos_acordo(v_ids, p_acordo_id);
  if not coalesce((v_res->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'erro', 'VINCULO_RECUSADO', 'detalhe', v_res);
  end if;
  insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
  values (p_acordo_id, s.composicao_hash, v_ids, 'CONFIRMADA', s.nivel, s.motivo, v_email);
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'SUGESTAO_VINCULO_CONFIRMADA', 'acordos', p_acordo_id,
          jsonb_build_object('composicao_hash', s.composicao_hash, 'titulo_ids', v_ids, 'motivo', s.motivo, 'liquidacao_195', s.liquidacao_195));
  return jsonb_build_object('ok', true, 'acordo_id', p_acordo_id, 'titulo_ids', v_ids, 'resultado', v_res);
end
$$;

revoke all on function public.acordo_vinculo_sugestao_confirmar(uuid, text) from public;
revoke all on function public.acordo_vinculo_sugestao_confirmar(uuid, text) from anon;
grant execute on function public.acordo_vinculo_sugestao_confirmar(uuid, text) to authenticated;
grant execute on function public.acordo_vinculo_sugestao_confirmar(uuid, text) to service_role;
