-- CONFERENCIA DE PAGAMENTO: A DECISAO PASSA A APARECER NA FICHA DO ALUNO.
--
-- Ate aqui, FEITO e REJEITAR (20260923020000) gravavam em DOIS lugares: a linha
-- da `fila_pagamento_sem_vinculo` e a `auditoria` tecnica. Quem abre a ficha do
-- aluno nao via nada -- a decisao existia, mas nao no lugar onde o operador
-- conta a historia do caso. Esta migration acrescenta o TERCEIRO lugar, e so
-- isso.
--
-- SO A DECISAO HUMANA FINAL ENTRA NA FICHA. A movimentacao e escrita dentro de
-- `conciliacao_feito` e `conciliacao_rejeitar`, que sao exatamente as duas
-- portas que exigem gestao logada e uma categoria escolhida a mao. O motor
-- horario, o reprocessamento e as rotinas automaticas (RESOLVIDO_AUTOMATICO,
-- encerrar_ja_paga_conferida, recuperar_acordo_avista) nao passam por elas e
-- continuam sem escrever na ficha -- tentativa nao e decisao.
--
-- NENHUM EFEITO FINANCEIRO, E ISSO FOI AUDITADO GATILHO A GATILHO.
-- `aluno_movimentacoes` tem tres gatilhos AFTER INSERT, e os tres saem antes de
-- fazer qualquer coisa com o tipo novo:
--
--   fn_atualizar_ultimo_acionamento .... sai em `not eh_tipo_acionamento(tipo)`.
--       A lista de acionamento e fechada e NAO tem CONFERENCIA_PAGAMENTO; logo
--       nao mexe em alunos.data_ultimo_acionamento, nao mexe em casos e nao
--       chama recalcular_situacao_aluno. Conferir a pendencia nao pode contar
--       como contato com o aluno -- isso mudaria fila, nivelamento e cobertura.
--   sincronizar_elogio_da_movimentacao . sai em `status_novo <> 'ELOGIO_ATENDIMENTO'`.
--       Gravamos status_novo NULO de proposito.
--   _trg_desfazer_cartao_tabulacao ..... sai em `tipo <> 'FINALIZACAO_ATENDIMENTO'`.
--
-- `valor_movimentacao` FICA NULO DE PROPOSITO. A coluna existe e caberia o
-- valor do pagamento, mas ela e escrita por funcoes que tratam dinheiro de
-- verdade (honorario, link de pagamento, conferencia Prime). Preencher aqui
-- criaria o risco de esta linha historica entrar em alguma soma. O valor vai
-- no TEXTO, onde e informacao e nao numero somavel.
--
-- A movimentacao nao cria acordo, nao cria parcela, nao baixa, nao altera
-- saldo, nao altera mensalidade e nao reativa acordo nenhum. E historico.
--
-- PAGAMENTO SEM ALUNO NAO GERA MOVIMENTACAO: `aluno_movimentacoes.aluno_id` e
-- NOT NULL, e ficha de ninguem nao existe. A decisao continua na fila e na
-- auditoria, como antes.
--
-- A SEGUNDA PARTE desta migration da a `pagamentos_sem_aluno` os tres campos
-- que faltavam para conferir sem sair da fila: o acordo identificado, as
-- evidencias que existem e o saldo atual do aluno. Sao colunas NOVAS no fim do
-- RETURNS TABLE -- nenhuma das existentes muda de nome, tipo ou ordem.

-- ===========================================================================
-- 1. O TEXTO DA FICHA, EM UM LUGAR SO
-- ===========================================================================
--
-- Os dois caminhos (FEITO e REJEITAR) escrevem a mesma forma. Deixar o texto
-- duplicado nas duas funcoes garantiria que um dia eles divergissem.
--
-- OS ROTULOS SAO OS MESMOS DO CATALOGO. Os codigos vem das restricoes
-- `fila_pag_conclusao_valida` e `fila_pag_motivo_rejeicao_valido`
-- (20260923020000) e os rotulos sao os de `src/utils/conciliacaoPagamento.js`.
-- O teste desta migration compara os dois conjuntos e falha se um lado ganhar
-- um codigo que o outro nao conhece.

create or replace function public._conferencia_pagamento_na_ficha(
  p_pagamento_id uuid,
  p_decisao      text,   -- 'FEITO' | 'REJEITADO'
  p_categoria    text,   -- conclusao (FEITO) ou motivo_rejeicao (REJEITADO)
  p_observacao   text,
  p_email        text
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_p record;
  v_rotulo text;
  v_acordo text;
  v_texto text;
  v_id uuid;
begin
  select p.aluno_id, p.data_pagamento, p.valor_pago, p.numero_parcela_completo,
         p.titulo_numero
    into v_p
    from public.pagamentos p
   where p.id = p_pagamento_id;

  -- Sem ficha nao ha historico de ficha. A decisao ja esta na fila e na
  -- auditoria; aqui simplesmente nao ha onde escrever.
  if not found or v_p.aluno_id is null then
    return null;
  end if;

  v_rotulo := case p_categoria
    when 'ENTRADA_DE_ACORDO'        then 'Confirmado como entrada de acordo'
    when 'PARCELA_DE_ACORDO'        then 'Confirmado como parcela de acordo'
    when 'JA_TRATADO'               then 'Pagamento ja tratado corretamente'
    when 'SEM_IMPACTO_FINANCEIRO'   then 'Sem impacto financeiro atual'
    when 'OUTRO_CONFIRMADO'         then 'Outro motivo confirmado'
    when 'NAO_E_ENTRADA_DE_ACORDO'  then 'Nao e entrada de acordo'
    when 'NAO_PERTENCE_AO_ACORDO'   then 'Nao pertence ao acordo indicado'
    when 'SEM_ESTRUTURA_SUFICIENTE' then 'Pagamento sem estrutura suficiente'
    when 'DOCUMENTO_INCOMPATIVEL'   then 'Boleto/documento incompativel'
    when 'VALOR_INCOMPATIVEL'       then 'Valor incompativel'
    when 'OUTRO'                    then 'Outro'
    -- Codigo que o catalogo ganhar depois aparece como ele mesmo, em vez de
    -- sumir da ficha por falta de rotulo.
    else coalesce(p_categoria, '(sem categoria)')
  end;

  -- O acordo identificado e o PREFIXO do boleto de acordo: 5 + acordo(6) +
  -- parcela(4). Diagnostico, nunca vinculo -- ninguem vira dono de acordo por
  -- causa desta linha.
  v_acordo := case
    when length(coalesce(v_p.numero_parcela_completo,'')) = 11
      then substring(v_p.numero_parcela_completo, 2, 6)
    else null
  end;

  v_texto :=
    'Conferencia de pagamento -- ' || p_decisao || E'\n'
    -- `G` e `D` seguem o lc_numeric do servidor e ja sairam "R$ 3,945.53" num
    -- banco com locale americano. `,` e `.` no molde sao literais, entao o
    -- numero sai sempre igual e o `translate` o vira para o formato daqui.
    || 'Pagamento de R$ ' || translate(to_char(coalesce(v_p.valor_pago,0), 'FM999,999,990.00'), ',.', '.,')
       || ' em ' || to_char(v_p.data_pagamento, 'DD/MM/YYYY')
       || ' -- boleto ' || coalesce(nullif(v_p.numero_parcela_completo,''), '(sem)')
       || case when coalesce(v_p.titulo_numero,'') = '' then ''
               else ' -- documento ' || v_p.titulo_numero end || E'\n'
    || case when v_acordo is null then ''
            else 'Acordo identificado: ' || v_acordo || E'\n' end
    || case when p_decisao = 'REJEITADO' then 'Motivo: ' else 'Conclusao: ' end
       || v_rotulo || E'\n'
    || case when coalesce(btrim(p_observacao),'') = '' then ''
            else 'Observacao: ' || btrim(p_observacao) || E'\n' end
    || 'Decisao registrada por ' || coalesce(p_email, 'gestao')
       || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || E'\n'
    || 'pagamento_id: ' || p_pagamento_id::text;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values
    (v_p.aluno_id::text, 'CONFERENCIA_PAGAMENTO', v_texto,
     coalesce(p_email,'gestao'), coalesce(p_email,'gestao'), now())
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public._conferencia_pagamento_na_ficha(uuid, text, text, text, text) is
  'Escreve na ficha do aluno a decisao humana final de conferencia de pagamento (FEITO/REJEITADO). Somente historico: o tipo CONFERENCIA_PAGAMENTO esta fora de eh_tipo_acionamento, status_novo fica nulo e valor_movimentacao fica nulo -- nenhum dos tres gatilhos de aluno_movimentacoes age, e a linha nao entra em soma financeira. Devolve NULL quando o pagamento nao tem aluno.';

revoke all on function public._conferencia_pagamento_na_ficha(uuid, text, text, text, text) from public, anon, authenticated;

-- ===========================================================================
-- 2. FEITO -- copia integral da versao vigente, com UMA insercao
-- ===========================================================================
--
-- Copia literal de 20260923020000. Nenhuma validacao mudou, nenhuma condicao
-- foi afrouxada: o portao da gestao, a exigencia de conclusao, a exigencia de
-- observacao no "outro", as saidas SEM_CONCILIACAO / JA_BAIXADO /
-- SEM_PENDENCIA_ABERTA, o UPDATE da fila, a trava de 1 linha e a auditoria
-- estao iguais. A unica diferenca e a chamada da ficha, depois da auditoria.

create or replace function public.conciliacao_feito(
  p_pagamento_id uuid, p_conclusao text, p_observacao text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text; v_mov uuid;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Concluir pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  if coalesce(trim(p_conclusao),'') = '' then
    raise exception 'FEITO exige a conclusao escolhida.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  if p_conclusao = 'OUTRO_CONFIRMADO' and v_obs is null then
    raise exception 'A conclusao "outro motivo confirmado" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  update public.fila_pagamento_sem_vinculo
     set decisao = 'FEITO',
         conclusao = p_conclusao,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'concluido pela gestao (' || p_conclusao || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'CONCLUSAO_ABORTADA: a linha da fila mudou durante a conclusao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_FEITO_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'conclusao', p_conclusao, 'observacao', v_obs,
                             'decisao', 'FEITO', 'sem_efeito_financeiro', true));

  -- TERCEIRO LUGAR: a ficha do aluno. Falha aqui nao pode desfazer a decisao
  -- ja gravada na fila e na auditoria -- o historico e importante, mas nao
  -- mais que a propria decisao.
  begin
    v_mov := public._conferencia_pagamento_na_ficha(
               p_pagamento_id, 'FEITO', p_conclusao, v_obs, v_email);
  exception when others then
    v_mov := null;
  end;

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'FEITO', 'conclusao', p_conclusao,
                            'movimentacao_id', v_mov, 'estado_anterior', v_antes);
end;
$function$;

-- ===========================================================================
-- 3. REJEITAR -- copia integral da versao vigente, com UMA insercao
-- ===========================================================================

create or replace function public.conciliacao_rejeitar(
  p_pagamento_id uuid, p_motivo text, p_observacao text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text; v_mov uuid;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Rejeitar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  if coalesce(trim(p_motivo),'') = '' then
    raise exception 'REJEITAR exige motivo.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  if p_motivo = 'OUTRO' and v_obs is null then
    raise exception 'O motivo "outro" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  -- REJEITAR NAO APAGA E NAO DESFAZ PAGAMENTO. A unica escrita e a decisao.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'REJEITADO',
         motivo_rejeicao = p_motivo,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'rejeitado pela gestao (' || p_motivo || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'REJEICAO_ABORTADA: a linha da fila mudou durante a rejeicao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_REJEITADA_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'motivo_rejeicao', p_motivo, 'observacao', v_obs,
                             'decisao', 'REJEITADO', 'sem_efeito_financeiro', true,
                             'pagamento_preservado', true));

  begin
    v_mov := public._conferencia_pagamento_na_ficha(
               p_pagamento_id, 'REJEITADO', p_motivo, v_obs, v_email);
  exception when others then
    v_mov := null;
  end;

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'REJEITADO', 'motivo_rejeicao', p_motivo,
                            'movimentacao_id', v_mov, 'estado_anterior', v_antes);
end;
$function$;

-- ===========================================================================
-- 4. A FILA GANHA O QUE FALTAVA PARA CONFERIR SEM SAIR DELA
-- ===========================================================================
--
-- Copia integral da versao vigente, com TRES colunas novas no fim -- acordo
-- identificado, evidencias e saldo. Nenhuma coluna existente muda de nome,
-- tipo ou posicao, entao a tela antiga continuaria funcionando.
--
-- TUDO AQUI E DIAGNOSTICO, NAO VINCULO. O prefixo do boleto diz qual acordo
-- ELE aponta; se esse acordo existe no CRM e uma pergunta separada, respondida
-- ao lado. Nenhum dos dois cria vinculo nenhum.

drop function if exists public.pagamentos_sem_aluno(text, boolean);

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null::text, p_todos_os_meses boolean default false)
 returns table(
   pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
   titulo_numero text, numero_parcela_completo text, valor_pago numeric,
   valor_honorario numeric, operador_nome text, operador_email text,
   motivo text, candidatos integer, motivo_financeiro text, sugestoes jsonb,
   detectado_em timestamp with time zone, importacao_id uuid, arquivo_nome text,
   status_conciliacao text, tem_aluno boolean,
   acordo_identificado text, evidencias jsonb, saldo_total numeric, saldo_vencido numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null),
    -- ACORDO IDENTIFICADO: o prefixo de 6 digitos do boleto de acordo
    -- (5 + acordo + parcela). Fora do padrao de 11 digitos, nao ha prefixo.
    ev.prefixo,
    -- EVIDENCIAS: o que EXISTE hoje, em fato verificavel. Nenhuma inferencia,
    -- nenhuma sugestao de acao -- a tela mostra e quem decide e a gestao.
    jsonb_build_object(
      'acordo_prefixo',        ev.prefixo,
      'acordo_no_crm',         ev.acordo_no_crm,
      'acordo_status',         ev.acordo_status,
      'parcela_com_este_boleto', ev.parcela_existe,
      'parcela_status',        ev.parcela_status,
      'documento',             nullif(p.titulo_numero,''),
      'cpf_no_portador_166',   ev.no_166,
      'consulta_estrutura',    f.consulta_estrutura_resultado,
      'evidencia_origem',      f.evidencia_origem,
      'evidencia_em',          f.evidencia_em,
      'tentativas',            coalesce(f.quantidade_tentativas, 0),
      'primeira_tentativa_em', f.primeira_tentativa_em,
      'ultima_tentativa_em',   f.ultima_tentativa_em
    ),
    al.saldo_total,
    al.saldo_vencido
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  left join public.alunos al on al.id = p.aluno_id
  left join lateral (
    select
      pref.v as prefixo,
      (ac.id is not null) as acordo_no_crm,
      ac.status as acordo_status,
      (pa.id is not null) as parcela_existe,
      pa.status as parcela_status,
      exists (select 1 from public.prime_portador_membro m
               where m.portador = 166
                 and lpad(m.cpf, 11, '0')
                   = lpad(regexp_replace(coalesce(p.cpf,''), '\D', '', 'g'), 11, '0')
                 and coalesce(p.cpf,'') <> '') as no_166
    from (select case when length(coalesce(p.numero_parcela_completo,'')) = 11
                      then substring(p.numero_parcela_completo, 2, 6) end as v) pref
    left join public.acordos ac
      on ac.numero_ulbra is not null
     and lpad(ac.numero_ulbra, 6, '0') = pref.v
     and upper(coalesce(ac.status,'')) <> 'CANCELADO'
    left join public.parcelas pa
      on pa.boleto = nullif(ltrim(coalesce(p.numero_parcela_completo,''),'0'), '')
  ) ev on true
  where (p.aluno_id is null or f.pagamento_id is not null)
    -- ENCERRADA SAI DA FILA ATIVA (17/09/2026). Sem isto, a linha decidida
    -- volta a aparecer pelo `p.aluno_id is null` -- e encerrar nao resolveria
    -- nada para quem olha a tela.
    and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                     where fd.pagamento_id = p.id and fd.decisao is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$function$;

comment on function public.pagamentos_sem_aluno(text, boolean) is
  'Fila de pagamentos sem baixa, para a gestao conferir. Desde 23/09/2026 devolve tambem o acordo identificado pelo prefixo do boleto, as evidencias verificaveis (acordo no CRM, parcela com o boleto, CPF no portador 166, consulta de estrutura, tentativas) e o saldo do aluno -- tudo diagnostico, nenhum vinculo.';

revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;
grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated, service_role;

-- === PROVAS ================================================================
do $prova$
declare v_src text; v_lista text;
begin
  -- 1. o tipo novo NAO pode ser acionamento: se entrar na lista, conferir a
  --    pendencia passaria a zerar dias_sem_acionamento do aluno.
  select prosrc into v_lista from pg_proc
    where oid = 'public.eh_tipo_acionamento(text)'::regprocedure;
  if v_lista like '%CONFERENCIA_PAGAMENTO%' then
    raise exception 'PROVA: CONFERENCIA_PAGAMENTO entrou em eh_tipo_acionamento -- viraria contato com o aluno';
  end if;

  -- 2. a ficha nao pode escrever status_novo (acionaria o gatilho do elogio)
  --    nem valor_movimentacao (entraria em soma financeira).
  select prosrc into v_src from pg_proc
    where oid = 'public._conferencia_pagamento_na_ficha(uuid,text,text,text,text)'::regprocedure;
  if v_src like '%status_novo%' or v_src like '%valor_movimentacao%' then
    raise exception 'PROVA: a movimentacao da conferencia nao pode preencher status_novo nem valor_movimentacao';
  end if;
  if v_src ~* '\m(update|delete)\M\s+(public\.)?(acordos|parcelas|alunos|acordos_titulos|pagamentos)\M' then
    raise exception 'PROVA: a movimentacao da conferencia tocou em tabela financeira';
  end if;

  -- 3. os dois caminhos humanos escrevem na ficha; ninguem mais.
  for v_src in
    select prosrc from pg_proc
     where oid in ('public.conciliacao_feito(uuid,text,text)'::regprocedure,
                   'public.conciliacao_rejeitar(uuid,text,text)'::regprocedure)
  loop
    if v_src not like '%_conferencia_pagamento_na_ficha%' then
      raise exception 'PROVA: decisao humana sem registro na ficha';
    end if;
    if v_src not like '%usuario_e_gestao%' then
      raise exception 'PROVA: a decisao perdeu o portao da gestao';
    end if;
  end loop;

  -- 4. a fila devolve os tres campos novos.
  if (select count(*) from information_schema.routines r
        join information_schema.parameters pa
          on pa.specific_name = r.specific_name
       where r.routine_schema='public' and r.routine_name='pagamentos_sem_aluno'
         and pa.parameter_name in ('acordo_identificado','evidencias','saldo_total','saldo_vencido')) <> 4 then
    raise exception 'PROVA: pagamentos_sem_aluno nao devolve os campos de conferencia';
  end if;

  if has_function_privilege('anon', 'public.pagamentos_sem_aluno(text,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._conferencia_pagamento_na_ficha(uuid,text,text,text,text)', 'EXECUTE') then
    raise exception 'PROVA: permissao aberta demais';
  end if;
end
$prova$;
