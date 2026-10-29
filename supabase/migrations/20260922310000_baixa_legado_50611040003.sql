-- CORRECAO AUTOMATICA DE UM UNICO CASO LEGADO: boleto 50611040003.
--
-- ONE-SHOT. Nao cria funcao, nao muda regra, nao mexe na fronteira de 14/09 e
-- nao libera nenhum dos 2.952 pagamentos antigos. Fecha exatamente um caso.
--
-- O CASO (auditoria somente leitura, 22/09/2026): o aluno do acordo 475 pagou
-- DUAS parcelas no mesmo dia, 17/08. Ha dois pagamentos de R$ 297,61 no mesmo
-- lote de importacao -- boletos ...0002 e ...0003. A parcela 2 foi baixada; a
-- parcela 3 (boleto 50611040003, vencimento 03/09) continua VENCIDA. Cada
-- parcela vale R$ 291,48; os R$ 6,13 a mais sao juros e multa. O dinheiro
-- entrou e nao foi aplicado.
--
-- POR QUE O MOTOR NAO PEGOU, e por que isso NAO e defeito do motor:
-- `baixa_pelo_relatorio` delega para `conciliacao_reprocessar`, que filtra por
-- `status_conciliacao is not null` -- a FRONTEIRA de 14/09/2026, decisao de
-- negocio: pagamento anterior a ela e invisivel para o motor, de proposito.
-- Este pagamento tem `status_conciliacao` nulo. Medido: o motor NAO tem teto de
-- tolerancia para juros/multa -- dos pagamentos que ele enxerga, 58 tem
-- diferenca acima de 5 centavos e 57 estao PAGO com origem GATILHO_IMPORTACAO,
-- com diferencas de R$ 1,75 a R$ 1.235,64. Se este caso estivesse dentro da
-- janela, teria sido baixado sozinho. So a data de entrada o separa.
--
-- POPULACAO EQUIVALENTE: exatamente 1 -- este. Dos 2.952 pagamentos invisiveis
-- ao motor, so 2 tem a parcela ainda aberta, e o outro (50692530001) tem
-- diferenca de 33,2% E acordo CANCELADO, que o fluxo oficial recusa. Por isso
-- a correcao e nominal, e nao uma regra.
--
-- FONTE DE VERDADE DOS EFEITOS: `baixar_parcela_acordo`, corpo vigente
-- md5(prosrc) = 369f5fdd59949ecc09246a663252faf3. O bloco de escrita abaixo
-- reproduz exatamente os dois comandos dela -- o UPDATE da parcela e o INSERT
-- da baixa, na mesma ordem e com os mesmos campos. O unico acrescimo e a
-- procedencia (observacao), que a RPC nao grava.
--
-- AUTORIA SEM FALSIFICAR PESSOA: `baixado_por_email` e `confirmado_por_email`
-- ficam como `correcao-legado@sistema`. NAO se escreve o e-mail de ninguem como
-- se tivesse clicado o botao. O `responsavel_baixa_email` segue a mesma regra do
-- fluxo oficial -- `operador_responsavel_email` do acordo -- porque ali o campo
-- significa "de quem e a carteira", nao "quem executou".
--
-- PASSA PELOS GATILHOS, NENHUM E DESABILITADO. Conferido um a um:
--   * trg_baixa_viva_unica_por_parcela (BEFORE INSERT): a parcela nao tem baixa
--     viva nem historica, entao passa -- e e justamente ela que garante que
--     rodar esta migration duas vezes nao cria duplicidade;
--   * trg_bloquear_baixa_acordo_encerrado: so barra acordo CANCELADO; o 475
--     esta ATIVO;
--   * trg_recalc_baixa: recalcula o aluno, o que AQUI e desejado -- a parcela
--     mudou de verdade, o saldo tem de acompanhar;
--   * trg_parcela_pago_em_automatico (BEFORE UPDATE): so preenche `pago_em`
--     quando vem nulo. Gravamos 17/08 explicitamente, entao ele nao sobrescreve;
--   * trg_bloquear_parcela_baixa_acordo_encerrado: idem, so acordo CANCELADO;
--   * trg_acordo_fecha_com_a_ultima_parcela: so quita o acordo quando nenhuma
--     parcela fica em aberto. A parcela 4 continua A_VENCER, entao o acordo 475
--     permanece ATIVO -- que e o resultado esperado.
--
-- ABORTA TUDO se qualquer premissa tiver mudado entre a revisao e a aplicacao.

do $legado$
declare
  v_parcela_id uuid := 'c411e507-b24a-4017-828d-5b93ee9210a1';
  v_acordo_id  uuid := '30a4d0cc-6c74-4604-a962-4871ba1c430b';
  v_boleto     text := '50611040003';
  v_valor      numeric := 297.61;
  v_honor      numeric := 21.59;
  v_data       date := date '2026-08-17';
  v_autor      text := 'correcao-legado@sistema';
  v_agora      timestamptz := now();
  v_parc       public.parcelas%rowtype;
  v_acordo     public.acordos%rowtype;
  v_aluno      public.alunos%rowtype;
  v_n          int;
  v_dup_antes  int;
  v_dup_depois int;
  v_baixa      uuid;
begin
  -- fotografia da duplicidade ANTES: o invariante desta migration e nao criar
  -- nenhuma nova. Contar um numero absoluto seria afirmar algo sobre dado
  -- alheio a este caso -- e quebraria fora de producao.
  select count(*) into v_dup_antes from (
    select parcela_id from public.baixas_pagamento
     where devolvido_em is null and parcela_id is not null
     group by parcela_id having count(*) > 1) d;
  -- ------------------------------------------------------------------ 1) premissas
  select * into v_parc from public.parcelas where id = v_parcela_id for update;
  if not found then
    raise exception 'ABORTADO: a parcela % nao existe.', v_parcela_id;
  end if;
  if coalesce(v_parc.boleto,'') <> v_boleto then
    raise exception 'ABORTADO: a parcela % tem boleto %, esperado %.', v_parcela_id, v_parc.boleto, v_boleto;
  end if;
  if upper(coalesce(v_parc.status,'')) <> 'VENCIDA' then
    raise exception 'ABORTADO: a parcela esta %, esperada VENCIDA.', v_parc.status;
  end if;
  if v_parc.pago_em is not null then
    raise exception 'ABORTADO: a parcela ja tem pago_em = %.', v_parc.pago_em;
  end if;
  if v_parc.acordo_id <> v_acordo_id then
    raise exception 'ABORTADO: a parcela pertence ao acordo %, esperado %.', v_parc.acordo_id, v_acordo_id;
  end if;

  select count(*) into v_n from public.parcelas where boleto = v_boleto;
  if v_n <> 1 then
    raise exception 'ABORTADO: o boleto % aparece em % parcelas, esperada 1.', v_boleto, v_n;
  end if;

  select * into v_acordo from public.acordos where id = v_acordo_id;
  if not found or upper(coalesce(v_acordo.status,'')) <> 'ATIVO' then
    raise exception 'ABORTADO: o acordo 475 esta %, esperado ATIVO.', coalesce(v_acordo.status,'(inexistente)');
  end if;

  -- exatamente um pagamento, com valor, data e honorario conferidos
  select count(*) into v_n
    from public.pagamentos
   where numero_parcela_completo = v_boleto;
  if v_n <> 1 then
    raise exception 'ABORTADO: ha % pagamentos para o boleto %, esperado 1.', v_n, v_boleto;
  end if;

  select count(*) into v_n
    from public.pagamentos
   where numero_parcela_completo = v_boleto
     and round(coalesce(valor_pago,0),2) = v_valor
     and data_pagamento = v_data
     and round(coalesce(valor_honorario,0),2) = v_honor;
  if v_n <> 1 then
    raise exception 'ABORTADO: o pagamento do boleto % nao confere com R$ %, data % e honorario R$ %.',
      v_boleto, v_valor, v_data, v_honor;
  end if;

  -- nenhuma baixa, viva OU historica, nesta parcela
  select count(*) into v_n from public.baixas_pagamento where parcela_id = v_parcela_id;
  if v_n <> 0 then
    raise exception 'ABORTADO: a parcela ja tem % baixa(s) registrada(s), esperadas 0.', v_n;
  end if;

  select * into v_aluno from public.alunos where id = v_acordo.aluno_id;

  -- ------------------------------------------------------------------ 2) os mesmos
  --    dois comandos de baixar_parcela_acordo, na mesma ordem.
  update public.parcelas
     set status = 'PAGO',
         pago_em = (v_data::timestamp at time zone 'America/Sao_Paulo'),
         confirmado_por_email = v_autor,
         atualizado_em = v_agora,
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'baixa automatica de legado em ' || to_char(v_agora,'DD/MM/YYYY')
           || ': pagamento de R$ 297,61 recebido em 17/08/2026 para parcela de R$ 291,48'
           || ' -- diferenca de R$ 6,13 e juros e multa. Caso anterior a fronteira de'
           || ' 14/09/2026, invisivel ao motor automatico; corrigido nominalmente.'
   where id = v_parcela_id;

  insert into public.baixas_pagamento (
    aluno_id, aluno_nome, aluno_cpf, parcela_id, acordo_id,
    valor_pago, honorarios_recebidos, data_pagamento, status_baixa,
    responsavel_baixa_email, baixado_por_email, baixado_por_nome,
    observacao_operador,
    recebido_em, atualizado_em, baixado_em
  ) values (
    v_acordo.aluno_id::text, v_aluno.nome, v_aluno.cpf, v_parcela_id, v_acordo.id,
    v_valor, v_honor, v_data, 'REALIZADA',
    coalesce(v_acordo.operador_responsavel_email, v_acordo.criado_por_email),
    v_autor, 'Correcao automatica de legado',
    'CORRECAO_LEGADO_50611040003_20260922: pagamento real de R$ 297,61 em 17/08/2026'
      || ' para parcela de R$ 291,48; R$ 6,13 de juros e multa. Anterior a fronteira'
      || ' de 14/09/2026, por isso nunca entrou no motor automatico.',
    v_agora, v_agora, v_agora
  ) returning id into v_baixa;

  -- ------------------------------------------------------------------ 3) resultado
  select * into v_parc from public.parcelas where id = v_parcela_id;
  if upper(coalesce(v_parc.status,'')) <> 'PAGO' then
    raise exception 'ABORTADO: a parcela ficou %, esperada PAGO.', v_parc.status;
  end if;
  if v_parc.pago_em <> (v_data::timestamp at time zone 'America/Sao_Paulo') then
    raise exception 'ABORTADO: pago_em ficou %, esperado 17/08/2026.', v_parc.pago_em;
  end if;

  select count(*) into v_n from public.baixas_pagamento
   where parcela_id = v_parcela_id and devolvido_em is null;
  if v_n <> 1 then
    raise exception 'ABORTADO: a parcela ficou com % baixas vivas, esperada 1.', v_n;
  end if;

  select count(*) into v_n from public.baixas_pagamento
   where id = v_baixa and round(valor_pago,2) = v_valor
     and round(coalesce(honorarios_recebidos,0),2) = v_honor
     and data_pagamento = v_data and status_baixa = 'REALIZADA'
     and baixado_por_email = v_autor;
  if v_n <> 1 then
    raise exception 'ABORTADO: a baixa criada nao confere com o esperado.';
  end if;

  -- o acordo NAO pode ter fechado: a parcela 4 continua em aberto
  select count(*) into v_n from public.acordos
   where id = v_acordo_id and upper(coalesce(status,'')) = 'ATIVO';
  if v_n <> 1 then
    raise exception 'ABORTADO: o acordo 475 deixou de estar ATIVO.';
  end if;

  -- e nenhuma duplicidade NOVA pode ter nascido
  select count(*) into v_dup_depois from (
    select parcela_id from public.baixas_pagamento
     where devolvido_em is null and parcela_id is not null
     group by parcela_id having count(*) > 1) d;
  if v_dup_depois <> v_dup_antes then
    raise exception 'ABORTADO: duplicidades passaram de % para %.', v_dup_antes, v_dup_depois;
  end if;

  raise notice 'CORRECAO DE LEGADO OK: boleto 50611040003 baixado (baixa %), parcela % -> PAGO, acordo 475 segue ATIVO.',
    v_baixa, v_parcela_id;
end;
$legado$;
