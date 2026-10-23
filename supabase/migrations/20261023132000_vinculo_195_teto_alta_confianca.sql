-- VINCULO ACORDO x MENSALIDADE PELO PRIME 195: o teto de ALTA_CONFIANCA passa a
-- ser mecanico, e nenhuma mensalidade sai do saldo sem parcela viva no lugar.
--
-- A REGRA APROVADA PELA GESTAO EM 23/10/2026, depois do diagnostico desta data.
-- Tres mudancas de comportamento e uma de vocabulario. Nenhuma toca dinheiro:
-- ZERO DML sobre pagamento, acordo, parcela, baixa, status, saldo ou vinculo
-- existente. Nada de backfill: os 76 vinculos ja decididos ficam como estao.
--
-- O QUE O DIAGNOSTICO MEDIU, e que justifica cada mudanca (producao, 23/10):
--
--   67 sugestoes FORTE: 56 de acordo ATIVO (R$ 60.575,44, saldo integral em
--   aberto) e 11 de acordo QUITADO (R$ 3.522,89). Todas as 67 tem
--   `liquidacao_195` -- a liquidacao e condicao dura do criterio.
--
--   A DUPLA COBRANCA JA EXISTE, ANTES DE CONFIRMAR: as 74 mensalidades das 56
--   sugestoes ATIVO somam R$ 59.695,80 e CONTAM no saldo hoje, ao lado das
--   parcelas vivas dos mesmos acordos (R$ 60.575,44). Confirmar o vinculo e o
--   que remove a duplicidade, porque `recalcular_situacao_aluno` exclui do
--   saldo todo titulo com vinculo ATIVO a acordo nao cancelado e nao quitado.
--   Nenhuma das 74 esta sendo excluida por `titulo_superado_por_acordo`.
--
--   E a duplicidade NAO vaza no que ja foi vinculado: das 2.808 mensalidades
--   NEGOCIADO (R$ 6.575.951,32), 2.808 tem vinculo ativo a acordo ATIVO e estao
--   fora do saldo. O anti-duplicidade e o VINCULO, nunca a `situacao` --
--   `situacao in ('ABERTO','NEGOCIADO')` sozinho contaria R$ 6,49 mi em dobro.
--
-- MUDANCA 1 -- FORTE exige acordo ATIVO. Os 11 QUITADO caem para REVISAO.
-- Em acordo QUITADO o efeito de vincular e QUITAR a mensalidade
-- (`situacao='PAGO'`, `status='quitada'`), e quitacao exige pagamento
-- comprovado -- nao inferencia por janela de data. Motivo novo:
-- `ACORDO_QUITADO_EXIGE_REVISAO`.
--
-- MUDANCA 2 -- FORTE exige pelo menos uma parcela viva no acordo. Sem parcela
-- viva, confirmar tiraria a mensalidade do saldo e NADA entraria no lugar: a
-- divida sumiria da cobranca. E o mesmo furo que em 24/09/2026 fez
-- R$ 24.460,12 desaparecerem por vinculo automatico a acordo QUITADO. Hoje
-- nenhuma das 56 cai aqui (todas tem parcela viva), entao este ramo e
-- DEFENSIVO -- dito de proposito, para ninguem o ler como correcao de um caso
-- existente. Motivo novo: `ACORDO_SEM_PARCELA_VIVA`.
--
-- MUDANCA 3 -- a RPC compartilhada recusa acordo ATIVO sem parcela viva.
-- Mesma regra da mudanca 2, uma camada abaixo, para valer em QUALQUER caminho
-- e nao so na tela de sugestoes. Atinge 4 acordos ATIVO em producao -- os
-- unicos ATIVO com parcelas e nenhuma viva, que sao anomalia de dado, nao
-- operacao legitima. ATIVO sem parcela NENHUMA: zero.
--
-- POR QUE A MUDANCA 1 *NAO* ENTRA NA RPC COMPARTILHADA -- e o ponto que a
-- medicao salvou. `vincular_titulos_acordo` e um hub com SEIS chamadores SQL
-- (`acordo_avista_registrar`, `acordo_saldo_residual`,
-- `acordo_vinculo_automatico_processar`, `acordo_vinculo_sugestao_confirmar`,
-- `prime_conferencia_vincular`, `vincular_titulos_acordo_gestao`) e quatro
-- componentes de tela. Uma recusa generica a acordo QUITADO ali ABORTARIA a
-- recuperacao do acordo a vista, que esta LIGADA e ja fez 150 casos: ela cria
-- o acordo ATIVO, insere a parcela ja `PAGO` (que `parcela_viva` considera NAO
-- viva), o gatilho `trg_acordo_fecha_com_a_ultima_parcela` fecha o acordo em
-- QUITADO, e so entao ela chama o vinculo. Prova de que e assim: as 171
-- mensalidades desse fluxo estao `PAGO/quitada`, o ramo `v_quitado` da RPC --
-- que so roda com acordo QUITADO. Ali quitar a mensalidade esta CORRETO,
-- porque o pagamento existe e esta comprovado no boleto.
-- Por isso a mudanca 1 vive no CALCULO DO NIVEL, nao no hub.
--
-- E o calculo do nivel protege os dois caminhos de uma vez: a tela mostra
-- "Confirmar" so em FORTE, e o job 57 (`acordo_vinculo_automatico`, hoje
-- `active = false` desde a pausa de 24/09) filtra `nivel = 'FORTE'`. Se alguem
-- religar o job, ele ja nasce com as duas restricoes.
--
-- MUDANCA 4 -- VOCABULARIO, na tela (arquivo separado desta migration).
-- O rotulo "Confirmar vinculo" promete mais do que a regra entrega. A decisao
-- da gestao de 12/09/2026 (`docs/CLASSIFICACAO-VINCULO-ACORDO-MENSALIDADE.md`)
-- fixa o teto em ALTA_CONFIANCA e proibe `CONFIRMADO`, porque o lado da
-- mensalidade e prova (boleto exato) e o lado do acordo e inferencia
-- (proximidade de data, janela -60/+7).
--
-- O QUE NAO MUDA, e eu disse errado no diagnostico: `acordo_vinculo_sugestao_decisao`
-- JA grava a coluna `nivel` -- `acordo_vinculo_sugestao_confirmar` escreve
-- `s.nivel` desde sempre. Nao havia o que corrigir ali. E o valor
-- `decisao='CONFIRMADA'` NAO e renomeado: sao 76 linhas de historico
-- append-only, com CHECK proprio e quatro leitores, e renomear reescreveria
-- vocabulario retroativamente sem ganho de comportamento.
--
-- NAO MUDA TAMBEM: o criterio de evidencia (CPF + boleto inteiro + liquidacao
-- 195 + janela -60/+7 + teste de concorrencia), a janela, `parcela_viva`,
-- `_fila_pagamento_tentativa`, `recalcular_situacao_aluno`, os jobs, e a etapa
-- `vinculo_por_negociacao` (que segue DESLIGADA desde 12/09).
--
-- PATCH ANCORADO, nao reescrita. As duas funcoes grandes sao alteradas por
-- substituicao de trecho sobre `pg_get_functiondef`, e a idempotencia e
-- verificada pelo TEXTO NOVO -- rodar duas vezes nao duplica nada e nao
-- depende de o texto velho ainda estar la.
--
-- ESTA MIGRATION NAO FOI APLICADA EM PRODUCAO.

-- ============================================================================
-- 1 e 2. O CALCULO DO NIVEL: FORTE exige acordo ATIVO e parcela viva.
-- ============================================================================
do $patch_nivel$
declare
  v_src   text := pg_get_functiondef('public.acordo_vinculo_sugestoes_calcular(uuid)'::regprocedure);
  v_novo  text;
  v_ancora_r constant text :=
    'exists (select 1 from gj x where x.acordo_id = ac.id and x.na_janela and x.conc is not null) tem_conc';
  v_ancora_nivel constant text :=
    'case when r.ng_win = 0 then ''SEM_EVIDENCIA'' when r.ng_win = 1 and not r.tem_conc then ''FORTE'' else ''REVISAO'' end';
  v_ancora_motivo constant text :=
    'when r.tem_conc then ''ACORDO_CONCORRENTE''';
begin
  -- Idempotencia pelo texto NOVO: se a marca ja esta la, nada a fazer.
  if position('ACORDO_SEM_PARCELA_VIVA' in v_src) > 0 then
    raise notice 'nivel: patch ja aplicado, nada a fazer';
    return;
  end if;

  if position(v_ancora_r in v_src) = 0
     or position(v_ancora_nivel in v_src) = 0
     or position(v_ancora_motivo in v_src) = 0 then
    raise exception 'vinculo 195: ancora nao encontrada em acordo_vinculo_sugestoes_calcular -- '
                    'o corpo de producao mudou e este patch nao pode ser aplicado as cegas.';
  end if;

  -- (a) a contagem de parcelas vivas entra no CTE `r`, uma vez por acordo.
  v_novo := replace(v_src, v_ancora_r,
    v_ancora_r || ',' || chr(10) ||
    '           (select count(*) from public.parcelas p' || chr(10) ||
    '             where p.acordo_id = ac.id and public.parcela_viva(p.status))::int parc_vivas');

  -- (b) FORTE passa a exigir acordo ATIVO e pelo menos uma parcela viva.
  v_novo := replace(v_novo, v_ancora_nivel,
    'case when r.ng_win = 0 then ''SEM_EVIDENCIA''' || chr(10) ||
    '              when r.ng_win = 1 and not r.tem_conc and r.st = ''ATIVO'' and r.parc_vivas > 0' || chr(10) ||
    '                then ''FORTE''' || chr(10) ||
    '              else ''REVISAO'' end');

  -- (c) os dois motivos novos, DEPOIS de ACORDO_CONCORRENTE para nao mudar a
  --     precedencia do que ja existia.
  v_novo := replace(v_novo, v_ancora_motivo,
    v_ancora_motivo || chr(10) ||
    '              when r.st <> ''ATIVO'' then ''ACORDO_QUITADO_EXIGE_REVISAO''' || chr(10) ||
    '              when r.parc_vivas = 0 then ''ACORDO_SEM_PARCELA_VIVA''');

  if v_novo = v_src then
    raise exception 'vinculo 195: o patch do nivel nao alterou nada.';
  end if;
  execute v_novo;
end
$patch_nivel$;

-- ============================================================================
-- 3. A RPC COMPARTILHADA: acordo ATIVO sem parcela viva passa a ser recusado.
--
-- SO para ATIVO, de proposito. Ver o cabecalho: uma recusa a QUITADO aqui
-- abortaria a recuperacao do acordo a vista.
-- ============================================================================
do $patch_rpc$
declare
  v_src  text := pg_get_functiondef('public.vincular_titulos_acordo(uuid[], uuid)'::regprocedure);
  v_novo text;
  v_ancora constant text :=
    'elsif v_status_acordo not in (''ATIVO'',''QUITADO'') then' || chr(10) ||
    '    return jsonb_build_object(''ok'',false,''erro'',''ACORDO_NAO_ATIVO'');' || chr(10) ||
    '  end if;';
begin
  if position('ACORDO_ATIVO_SEM_PARCELA_VIVA' in v_src) > 0 then
    raise notice 'rpc: patch ja aplicado, nada a fazer';
    return;
  end if;

  if position(v_ancora in v_src) = 0 then
    raise exception 'vinculo 195: ancora do status nao encontrada em vincular_titulos_acordo -- '
                    'o corpo de producao mudou e este patch nao pode ser aplicado as cegas.';
  end if;

  v_novo := replace(v_src, v_ancora,
    v_ancora || chr(10) || chr(10) ||
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
    '  end if;');

  if v_novo = v_src then
    raise exception 'vinculo 195: o patch da RPC nao alterou nada.';
  end if;
  execute v_novo;
end
$patch_rpc$;

-- ============================================================================
-- 4. A PORTA DA TELA: erros que dizem a verdade em vez de "nao e forte".
--
-- Defesa em profundidade. O `nivel <> 'FORTE'` acima ja barraria, mas o erro
-- generico nao diz A QUAL regra a pessoa esbarrou -- e e a tela que ela le.
-- Reescrita completa (1.853 bytes) em vez de patch: cabe inteira aqui.
-- ============================================================================
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

  -- 23/10/2026. As duas recusas explicitas vem ANTES do teste de nivel porque
  -- dizem QUAL regra barrou. Em acordo QUITADO vincular QUITA a mensalidade, e
  -- quitacao exige pagamento comprovado -- nao inferencia por janela de data;
  -- o caminho e a revisao manual, nao o botao de um clique.
  if upper(coalesce(s.status,'')) <> 'ATIVO' then
    return jsonb_build_object('ok', false, 'erro', 'ACORDO_NAO_ATIVO_EXIGE_REVISAO',
      'status', s.status, 'nivel', s.nivel,
      'detalhe', 'acordo fora de ATIVO quita a mensalidade ao vincular: so por revisao manual');
  end if;
  if not exists (select 1 from public.parcelas p
                  where p.acordo_id = p_acordo_id and public.parcela_viva(p.status)) then
    return jsonb_build_object('ok', false, 'erro', 'ACORDO_SEM_PARCELA_VIVA',
      'nivel', s.nivel,
      'detalhe', 'sem parcela viva, vincular tiraria a mensalidade do saldo sem nada entrar no lugar');
  end if;

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
  -- `decisao` segue 'CONFIRMADA': e historico append-only com CHECK proprio e 4
  -- leitores, e a coluna `nivel` -- que ja era gravada -- e quem diz que o teto
  -- e ALTA_CONFIANCA. O vocabulario que a pessoa le muda na TELA.
  insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
  values (p_acordo_id, s.composicao_hash, v_ids, 'CONFIRMADA', s.nivel, s.motivo, v_email);
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'SUGESTAO_VINCULO_CONFIRMADA', 'acordos', p_acordo_id,
          jsonb_build_object('composicao_hash', s.composicao_hash, 'titulo_ids', v_ids, 'motivo', s.motivo,
                             'liquidacao_195', s.liquidacao_195, 'teto_classificacao', 'ALTA_CONFIANCA'));
  return jsonb_build_object('ok', true, 'acordo_id', p_acordo_id, 'titulo_ids', v_ids, 'resultado', v_res,
                            'teto_classificacao', 'ALTA_CONFIANCA');
end
$$;

revoke all on function public.acordo_vinculo_sugestao_confirmar(uuid, text) from public;
revoke all on function public.acordo_vinculo_sugestao_confirmar(uuid, text) from anon;
grant execute on function public.acordo_vinculo_sugestao_confirmar(uuid, text) to authenticated;
grant execute on function public.acordo_vinculo_sugestao_confirmar(uuid, text) to service_role;

-- ============================================================================
-- PORTAO DE SANIDADE. Falha a migration em vez de mentir depois.
-- ============================================================================
do $guarda$
declare v_src text;
begin
  v_src := pg_get_functiondef('public.acordo_vinculo_sugestoes_calcular(uuid)'::regprocedure);
  if position('ACORDO_QUITADO_EXIGE_REVISAO' in v_src) = 0
     or position('ACORDO_SEM_PARCELA_VIVA' in v_src) = 0
     or position('r.parc_vivas > 0' in v_src) = 0 then
    raise exception 'vinculo 195: o calculo do nivel nao recebeu as duas restricoes.';
  end if;
  -- o criterio de evidencia tem de continuar intacto
  if position('e.portador = 195' in v_src) = 0 or position('liquidado_em is not null' in v_src) = 0 then
    raise exception 'vinculo 195: o criterio de evidencia do portador 195 saiu da funcao.';
  end if;

  v_src := pg_get_functiondef('public.vincular_titulos_acordo(uuid[], uuid)'::regprocedure);
  if position('ACORDO_ATIVO_SEM_PARCELA_VIVA' in v_src) = 0 then
    raise exception 'vinculo 195: a RPC nao recebeu a trava de parcela viva.';
  end if;
  -- A TRAVA NAO PODE ALCANCAR QUITADO: seria abortar a recuperacao do a vista.
  if position('v_status_acordo = ''ATIVO''' in v_src) = 0 then
    raise exception 'vinculo 195: a trava de parcela viva deixou de ser restrita a ATIVO.';
  end if;
  -- o ramo que quita a mensalidade junto com o acordo pago continua existindo
  if position('v_quitado' in v_src) = 0 then
    raise exception 'vinculo 195: o ramo v_quitado desapareceu da RPC.';
  end if;

  v_src := (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'acordo_vinculo_sugestao_confirmar');
  if position('ACORDO_NAO_ATIVO_EXIGE_REVISAO' in v_src) = 0
     or position('ACORDO_SEM_PARCELA_VIVA' in v_src) = 0 then
    raise exception 'vinculo 195: a porta da tela nao recebeu as recusas explicitas.';
  end if;
  if position('usuario_e_gestao' in v_src) = 0 then
    raise exception 'vinculo 195: o portao de gestao saiu da porta da tela.';
  end if;
  if not has_function_privilege('authenticated',
        'public.acordo_vinculo_sugestao_confirmar(uuid,text)', 'EXECUTE') then
    raise exception 'vinculo 195: authenticated perdeu o EXECUTE e a tela quebraria.';
  end if;

  -- A etapa desligada em 12/09 nao pode ter sido religada por efeito colateral.
  if exists (select 1 from public.fluxo_pagamentos_config
              where etapa = 'vinculo_por_negociacao' and ligado is true) then
    raise exception 'vinculo 195: vinculo_por_negociacao foi religada -- nao e esta frente.';
  end if;
end
$guarda$;
