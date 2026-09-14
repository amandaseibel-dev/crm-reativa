-- NEGOCIACAO COMPROVADA SEM ESTRUTURA DE ACORDO.
--
-- O BURACO. O `Relatorio de Titulos em Aberto (Acordo)` -- unica fonte de acordo
-- do CRM -- so traz acordo que TEM titulo em aberto no instante da extracao.
-- Quem paga antes da proxima extracao some do relatorio para sempre: o acordo
-- nunca entra no CRM e o pagamento fica `AGUARDANDO_ACORDO` indefinidamente.
--
-- Medido em 14/09/2026: os 13 pagamentos nesse estado (R$ 7.658,02) tem numeros
-- de acordo INTERCALADOS com acordos que a importacao do mesmo dia trouxe --
-- 71643 e 71645 entre 71637 e 71650; 71803 entre 71765 e 71818. Nao e "ainda
-- nao chegou": o relatorio passou por cima e pulou exatamente esses.
--
-- A PROVA QUE EXISTE. No Prime, o debito negociado migra do portador 195
-- (REATIVA RECUPERACAO, mensalidade em cobranca) para o 166 (SANTANDER REATIVA -
-- CONVENIO 272047). Estar no 166 e evidencia objetiva de negociacao -- regra da
-- gestao, e ja documentada no cabecalho de `prime-portador` desde 24/08/2026.
-- Essa filiacao ja e coletada: `prime_portador_membro` tem 33.014 linhas, 12.695
-- no portador 166.
--
-- O QUE A API NAO DA, e por isso nao se reconstroi acordo. Medido em 59 alunos
-- do portador 166, 1.605 linhas de extrato: `agreements` responde 200 com lista
-- vazia em 100% dos casos, `newInstallments` nao aparece uma unica vez,
-- `isAgreementInstallment` e falso em 100%, e o portador 166 nao aparece em
-- NENHUMA linha de extrato. Inclusive para um acordo ATIVO com parcelas em
-- aberto -- entao nao e "some depois de pago": nao vem em estado nenhum.
--
-- O QUE ESTA MIGRATION FAZ:
--   1. `status_conciliacao` ganha ACORDO_CONFIRMADO_SEM_ESTRUTURA;
--   2. a fila ganha DUAS colunas de evidencia -- e so duas;
--   3. o motor passa a consultar `prime_portador_membro` quando nao acha o
--      acordo, e a manter a confirmacao entre rodadas;
--   4. entra uma RPC para o caminho ao vivo registrar a confirmacao e o vinculo
--      por CPF, e chamar o motor.
--
-- O QUE ELA NAO FAZ: nao cria `acordos`, nao cria `parcelas`, nao inventa valor
-- total nem quantidade de parcelas, nao da baixa, nao usa o Prime como fonte de
-- baixa, nao usa o sufixo do boleto como numero de parcela, nao toca
-- `acordo_reconstruir_cron`, nao faz backfill e nao encosta nos 8.999 pagamentos
-- historicos com `status_conciliacao IS NULL`.
--
-- AUSENCIA NAO E PROVA NEGATIVA. Nao estar no 166 -- no espelho ou ao vivo --
-- nunca conclui que nao houve acordo. Conclui que aqui nao da para afirmar, e o
-- caso segue pendente para decisao humana.
--
-- POR QUE DUAS COLUNAS, E NAO ZERO. Conferido antes de criar: `observacao` e
-- texto livre escrito por gente (`pagamento_vincular_aluno` e
-- `conciliacao_encerrar` escrevem ali) -- guardar origem de evidencia em prosa
-- exigiria parsear texto para filtrar e auditar. `sugestoes` e jsonb com
-- contrato declarado: candidatos por NOME, "nunca aplicados", e a tela le como
-- lista de alunos. `motivo` ja carrega a evidencia em texto legivel. O que falta
-- e um campo FILTRAVEL de origem e a data -- e nada existente serve sem quebrar
-- semantica. Todo o resto da evidencia reusa coluna que ja existe:
--   pagamento_id, boleto, valor_pago, valor_honorario e a primeira deteccao na
--   propria fila; aluno_id, cpf, titulo_numero e operador_email em `pagamentos`;
--   a registration em `fila.matricula_recebida` -- provado 13/13 que a matricula
--   do arquivo Santander E a `registration` do Prime.

-- ---------------------------------------------------------------------------
-- 1. O ESTADO NOVO
-- ---------------------------------------------------------------------------

do $ajuste$
declare v_con text;
begin
  select c.conname into v_con from pg_constraint c
   where c.conrelid = 'public.pagamentos'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%status_conciliacao%';
  if v_con is not null then
    execute format('alter table public.pagamentos drop constraint %I', v_con);
  end if;

  alter table public.pagamentos
    add constraint pagamentos_status_conciliacao_valido check (
      status_conciliacao is null or status_conciliacao in (
        'BAIXADO',
        'AGUARDANDO_ACORDO',
        'AGUARDANDO_AMARRACAO',
        'PARCELA_JA_PAGA',
        'REVISAO',
        'SEM_VINCULO',
        'ACORDO_CONFIRMADO_SEM_ESTRUTURA'  -- negociacao provada no 166, acordo ausente no CRM
      ));
end $ajuste$;

comment on column public.pagamentos.status_conciliacao is
  'Desfecho da conciliacao da parcela, decidido na insercao. Prospectivo a partir de 14/09/2026 -- NULL no historico, de proposito. ACORDO_CONFIRMADO_SEM_ESTRUTURA: ha prova externa de negociacao (portador 166 do Prime) e o acordo ainda nao entrou no CRM; nenhum acordo ou parcela e criado a partir disso. Nao tem estado "ja importado": linha ja importada e barrada ANTES do INSERT.';

-- ---------------------------------------------------------------------------
-- 2. AS DUAS COLUNAS DE EVIDENCIA
-- ---------------------------------------------------------------------------

alter table public.fila_pagamento_sem_vinculo
  add column if not exists evidencia_origem text,
  add column if not exists evidencia_em     timestamptz;

do $ev$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'fila_pag_evidencia_origem_valida') then
    alter table public.fila_pagamento_sem_vinculo
      add constraint fila_pag_evidencia_origem_valida check (
        evidencia_origem is null or evidencia_origem in (
          'PRIME_PORTADOR_MEMBRO',  -- espelho local da filiacao ao portador
          'PRIME_API_LIVE'          -- consulta pontual ao vivo
        ));
  end if;
end $ev$;

comment on column public.fila_pagamento_sem_vinculo.evidencia_origem is
  'De onde veio a prova de que o aluno esta no portador 166. PRIME_API_LIVE representa SOMENTE a origem da evidencia do portador -- nunca a origem do vinculo de identidade, que fica em pagamentos.origem_vinculo.';
comment on column public.fila_pagamento_sem_vinculo.evidencia_em is
  'Quando a evidencia do portador 166 foi coletada (espelho) ou confirmada (ao vivo).';

-- ---------------------------------------------------------------------------
-- 3. O MOTOR PASSA A CONSULTAR O ESPELHO, E A MANTER A CONFIRMACAO
-- ---------------------------------------------------------------------------

create or replace function public.pagamento_conciliar_um(
  p_pagamento_id uuid,
  p_aplicar boolean default true
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $motor$
declare
  v_pag record; v_parcela record;
  v_chave text; v_venc date; v_pref text;
  v_status text; v_motivo text;
  v_acordos int := 0; v_livres int := 0;
  v_cand int := 0; v_cand_id uuid;
  -- `v_parcela` pode nunca ser atribuida (linha sem boleto): ler `v_parcela.id`
  -- nesse caso levanta "record is not assigned yet". Estes dois guardam o
  -- resultado e sao nulos quando nao houve parcela.
  v_parcela_id uuid; v_acordo_id uuid;
  v_baixou boolean := false;
  v_evid jsonb := '{}'::jsonb;
  v_sug jsonb := '[]'::jsonb; v_arq text;
  v_origem text; v_origem_em timestamptz; v_quem text; v_dup int := 0;
  -- releitura da parcela DEPOIS do lock, antes de escrever
  v_re_status text; v_re_ref text;
  -- evidencia do portador 166 (negociacao comprovada, sem estrutura de acordo)
  v_cpf_pag text; v_ev_origem text; v_ev_em timestamptz;
begin
  select * into v_pag from public.pagamentos where id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  v_chave := ltrim(coalesce(v_pag.numero_parcela_completo,''),'0');
  v_venc  := public.vencimento_do_pagamento(v_pag.dados);

  if v_chave = '' then
    v_status := 'SEM_VINCULO';
    v_motivo := 'a linha do arquivo nao trouxe numero de boleto';
  else
    select p.id, p.valor, p.status, p.honorarios, p.acordo_id, p.vencimento, p.numero,
           p.boleto_confiavel, p.origem_baixa, p.origem_baixa_ref, p.origem_baixa_em,
           p.confirmado_por_email,
           a.aluno_id, a.status status_acordo
      into v_parcela
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.boleto = v_chave limit 1;

    v_parcela_id := v_parcela.id;
    v_acordo_id  := v_parcela.acordo_id;

    if v_parcela_id is null then
      -- Sem parcela com esse boleto. A classificacao abaixo e SOMENTE LEITURA e
      -- nao autoriza baixa nenhuma: diz o que falta, o acordo ou a amarracao.
      if length(coalesce(v_pag.numero_parcela_completo,'')) = 11 then
        v_pref := substring(v_pag.numero_parcela_completo, 2, 6);

        select count(*) into v_acordos
          from public.acordos a
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO';

        select count(*) into v_livres
          from public.acordos a join public.parcelas p on p.acordo_id = a.id
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO'
           and p.boleto is null
           and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA');

        if v_acordos = 0 then
          -- O acordo nao esta no CRM. Isso NAO significa que nao houve negociacao:
          -- o Relatorio de Titulos em Aberto so traz acordo COM titulo em aberto, e
          -- quem pagou some dele para sempre. A prova de que houve negociacao vem de
          -- fora: no Prime, o debito negociado migra do portador 195 (mensalidade em
          -- cobranca) para o 166 (SANTANDER REATIVA - CONVENIO 272047). Estar no 166
          -- e evidencia objetiva de acordo -- regra da gestao, e ja e o que o
          -- cabecalho de `prime-portador` documenta desde 24/08/2026.
          v_cpf_pag := nullif(regexp_replace(coalesce(v_pag.cpf,''), '\D', '', 'g'), '');

          if coalesce(v_pag.status_conciliacao,'') = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA' then
            -- IDEMPOTENCIA. Uma vez confirmado, nao volta para AGUARDANDO_ACORDO.
            -- O espelho do portador expira por ciclo (`prime-portador` apaga quem nao
            -- foi recarimbado na varredura). Sem esta parada, a confirmacao de hoje
            -- viraria pendencia de novo no sabado que vem -- e a evidencia ja gravada
            -- seria perdida. So se move para frente: quando o acordo aparecer.
            v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';
            v_motivo := 'negociacao comprovada pelo portador 166; o acordo ' || v_pref
              || ' ainda nao entrou no CRM. Sem estrutura: nenhum acordo ou parcela foi criado.';

          elsif v_cpf_pag is not null
            and exists (select 1 from public.prime_portador_membro m
                         where m.cpf = v_cpf_pag and m.portador = 166) then
            select max(m.coletado_em) into v_ev_em
              from public.prime_portador_membro m
             where m.cpf = v_cpf_pag and m.portador = 166;
            v_ev_origem := 'PRIME_PORTADOR_MEMBRO';
            v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';
            v_motivo := 'negociacao comprovada: o aluno esta no portador 166 (SANTANDER'
              || ' REATIVA) desde ' || coalesce(to_char(v_ev_em,'DD/MM/YYYY'),'?')
              || '. O acordo ' || v_pref || ' ainda nao entrou no CRM, e nenhum acordo'
              || ' ou parcela foi criado a partir desta evidencia.';

          else
            -- AUSENCIA NAO E PROVA NEGATIVA. Nao estar no espelho do 166 nao diz que
            -- nao houve negociacao -- diz que aqui nao temos como afirmar. A confirmacao
            -- ao vivo (caminho B) e quem pode promover este caso; ate la, fica pendente.
            v_status := 'AGUARDANDO_ACORDO';
            v_motivo := 'boleto ' || v_pag.numero_parcela_completo
              || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM'
              || case when v_cpf_pag is null
                      then ' | sem CPF no pagamento: identidade precisa ser resolvida antes'
                      else ' | sem evidencia local do portador 166 -- inconclusivo, nao e prova de que nao houve acordo' end;
          end if;
        elsif v_livres > 0 then
          v_status := 'AGUARDANDO_AMARRACAO';
          v_motivo := 'o acordo ' || v_pref || ' esta no CRM com ' || v_livres
            || ' parcela(s) sem boleto: falta amarrar o boleto '
            || v_pag.numero_parcela_completo || ' a parcela certa';
        else
          v_status := 'REVISAO';
          v_motivo := 'o acordo ' || v_pref
            || ' esta no CRM e nao tem parcela livre para receber o boleto '
            || v_pag.numero_parcela_completo;
        end if;
      else
        v_status := 'SEM_VINCULO';
        v_motivo := 'boleto fora do padrao de 11 digitos: ' || v_pag.numero_parcela_completo;
      end if;

    -- TRAVA DE IDEMPOTENCIA. Antes de qualquer outra coisa: esta parcela ja foi
    -- baixada POR ESTE pagamento? Entao o trabalho ja esta feito. Sem esta
    -- checagem, reprocessar confundiria a propria baixa com a de um terceiro e
    -- devolveria PARCELA_JA_PAGA -- pendencia falsa que nunca mais sai.
    elsif upper(coalesce(v_parcela.status,'')) = 'PAGO'
      and coalesce(v_parcela.origem_baixa_ref,'') = p_pagamento_id::text then
      v_status := 'BAIXADO';
      v_motivo := null;

    elsif v_parcela.status = 'PAGO' then
      -- Baixa anterior, de outra origem. NUNCA uma segunda baixa. A evidencia e
      -- computada aqui para a tela mostrar origem, data e responsavel.
      select b.baixado_por_email, b.baixado_em
        into v_quem, v_origem_em
        from public.baixas_pagamento b
       where b.parcela_id = v_parcela.id and b.devolvido_em is null
       order by b.baixado_em desc nulls last limit 1;

      v_origem := coalesce(v_parcela.origem_baixa,
                           case when v_quem is not null then 'BAIXA_REGISTRADA' end);
      v_quem   := coalesce(v_quem, v_parcela.origem_baixa_ref, v_parcela.confirmado_por_email);
      v_origem_em := coalesce(v_origem_em, v_parcela.origem_baixa_em);

      select count(*) into v_dup
        from public.pagamentos g
       where g.numero_parcela_completo = v_pag.numero_parcela_completo
         and g.id <> v_pag.id
         and round(coalesce(g.valor_pago,0),2) = round(coalesce(v_pag.valor_pago,0),2)
         and coalesce(g.retroativo,false) = false;

      v_evid := jsonb_build_object(
        'tem_evidencia', v_origem is not null,
        'origem', v_origem, 'responsavel', v_quem, 'quando', v_origem_em,
        'pagamentos_iguais_na_base', v_dup);

      v_status := 'PARCELA_JA_PAGA';
      v_motivo := 'a parcela ' || coalesce(v_parcela.numero::text,'?') || ' do boleto '
        || v_chave || ' ja estava PAGO antes deste pagamento entrar'
        || case when v_origem is not null
                then ': baixa anterior ' || v_origem
                     || coalesce(' por ' || v_quem, '')
                     || coalesce(' em ' || to_char(v_origem_em,'DD/MM/YYYY'), '')
                else ': nao ha registro de quem baixou' end
        || case when v_dup > 0
                then ' | ATENCAO: ha ' || v_dup || ' outro(s) pagamento(s) com o mesmo boleto e o mesmo valor'
                else '' end;

    elsif upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then
      v_status := 'REVISAO';
      v_motivo := 'o acordo do boleto ' || v_chave || ' esta '
        || upper(coalesce(v_parcela.status_acordo,'(sem status)')) || ', nao ATIVO';

    elsif v_pag.valor_pago < v_parcela.valor - 0.05
       or v_pag.valor_pago > v_parcela.valor * 1.15 then
      v_status := 'REVISAO';
      v_motivo := 'valor pago ' || to_char(v_pag.valor_pago,'FM999G999G990D00')
        || ' fora da faixa aceita para a parcela de '
        || to_char(v_parcela.valor,'FM999G999G990D00')
        || ' (de -R$ 0,05 ate +15%)';

    elsif not public.documento_casa_com_parcela(v_parcela.id, v_venc) then
      if p_aplicar then
        insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
        values ('rotina', 'BAIXA_DOCUMENTO_RECUSADA', 'parcelas', v_parcela.id,
                jsonb_build_object('pagamento_id', v_pag.id, 'documento', v_chave,
                                   'vencimento_extrato', v_venc, 'parcela_numero', v_parcela.numero,
                                   'parcela_vencimento', v_parcela.vencimento, 'valor_pago', v_pag.valor_pago,
                                   'motivo', case when v_venc is not null then 'vencimento do extrato nao bate com a parcela do boleto'
                                                  else 'ha parcela mais antiga em aberto no acordo' end));
      end if;
      v_status := 'REVISAO';
      v_motivo := case when v_venc is not null
        then 'vencimento do arquivo (' || to_char(v_venc,'DD/MM/YYYY')
             || ') nao bate com a parcela ' || coalesce(v_parcela.numero::text,'?')
             || ' do boleto, que vence ' || to_char(v_parcela.vencimento,'DD/MM/YYYY')
        else 'ha parcela mais antiga em aberto no acordo: o boleto ' || v_chave
             || ' nao pode baixar a parcela ' || coalesce(v_parcela.numero::text,'?') end;

    elsif not coalesce(v_parcela.boleto_confiavel, false) then
      -- AMARRACAO FRACA. O boleto veio do fallback legado por numero/sufixo, que
      -- acertou 5.969 de 10.924 parcelas quando foi medido em 08/09 -- nao e
      -- prova. Aqui a prova tem de vir de fora: entre as parcelas do MESMO
      -- acordo, exatamente UMA pode ser compativel com o que o Santander diz, e
      -- ela tem de ser justamente esta. Se o arquivo nao traz vencimento,
      -- nenhuma candidata qualifica e o caso cai em REVISAO -- que e o certo:
      -- sufixo sem data nao decide nada.
      select count(*), min(c.id::text)::uuid
        into v_cand, v_cand_id
        from public.parcelas c
       where c.acordo_id = v_parcela.acordo_id
         and upper(coalesce(c.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
         and v_venc is not null
         and abs(c.vencimento - v_venc) <= 3
         and v_pag.valor_pago >= c.valor - 0.05
         and v_pag.valor_pago <= c.valor * 1.15;

      if v_cand = 1 and v_cand_id = v_parcela.id then
        v_status := 'BAIXA';
      else
        v_status := 'REVISAO';
        v_motivo := 'o boleto ' || v_chave || ' foi amarrado pela regra legada de sufixo'
          || ' (boleto_confiavel = false) e '
          || case when v_cand = 0 then 'nenhuma parcela do acordo bate com o vencimento e o valor do Santander'
                  when v_cand > 1 then v_cand || ' parcelas do acordo batem: ambiguo por desenho'
                  else 'a parcela compativel e outra, nao a que esta com o boleto' end
          || '. Amarracao fraca nao baixa sozinha.';
      end if;

    else
      v_status := 'BAIXA';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- A PARTIR DAQUI, ESCRITA. Em previa (`p_aplicar => false`) nada disto roda.
  -- -------------------------------------------------------------------------
  if v_status = 'BAIXA' then
    if not p_aplicar then
      return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
        'status', 'BAIXADO', 'motivo', null, 'parcela_id', v_parcela_id,
        'acordo_id', v_acordo_id, 'aplicou', false, 'baixou', false,
        'boleto_confiavel', coalesce(v_parcela.boleto_confiavel,false));
    end if;

    -- O LOCK, E A RELEITURA DEPOIS DELE. A decisao acima foi tomada com a foto
    -- de ANTES do lock: duas transacoes podem ter decidido BAIXA ao mesmo tempo.
    -- Quem entra primeiro baixa; quem entra depois TEM de reler a parcela ja
    -- dentro do lock. Sem isso, o segundo sobrescreveria a baixa do primeiro, ou
    -- -- pior -- marcaria BAIXADO sem ter escrito nada.
    perform pg_advisory_xact_lock(hashtextextended(v_parcela_id::text, 0));

    select upper(coalesce(p.status,'')), coalesce(p.origem_baixa_ref,'')
      into v_re_status, v_re_ref
      from public.parcelas p
     where p.id = v_parcela_id;

    if v_re_status = 'PAGO' then
      if v_re_ref = p_pagamento_id::text then
        -- Fui eu mesmo, nesta ou noutra transacao. Nada a escrever.
        v_status := 'BAIXADO';
        v_motivo := null;
      else
        -- Outro pagamento chegou primeiro. NUNCA uma segunda baixa, e NAO fecha
        -- sozinho: vai para conferencia humana como qualquer PARCELA_JA_PAGA.
        v_status := 'PARCELA_JA_PAGA';
        v_motivo := 'a parcela ' || coalesce(v_parcela.numero::text,'?') || ' do boleto '
          || v_chave || ' foi baixada por outro pagamento entre a decisao e a escrita'
          || case when v_re_ref <> '' then ' (referencia ' || v_re_ref || ')' else '' end
          || '. Nenhuma segunda baixa foi feita.';
        v_evid := jsonb_build_object('tem_evidencia', v_re_ref <> '',
                                     'origem', 'CORRIDA_NA_BAIXA',
                                     'responsavel', nullif(v_re_ref,''), 'quando', now());
      end if;
    else
      update public.parcelas
         set status = 'PAGO', pago_em = v_pag.data_pagamento,
             confirmado_por_email = coalesce(v_pag.operador_email,'extrato_santander'),
             origem_baixa = 'GATILHO_IMPORTACAO',
             origem_baixa_ref = v_pag.id::text,
             origem_baixa_em = now(),
             honorarios = case when coalesce(honorarios,0) = 0 and coalesce(v_pag.valor_honorario,0) > 0
                               then v_pag.valor_honorario else honorarios end,
             observacao = coalesce(observacao,'')
               || case when coalesce(observacao,'') = '' then '' else ' | ' end
               || 'baixa automatica na importacao: documento ' || v_chave
               || ' pago em ' || to_char(v_pag.data_pagamento,'DD/MM/YYYY')
               || case when v_venc is not null then ' (vencimento ' || to_char(v_venc,'DD/MM/YYYY') || ' conferido)' else '' end,
             atualizado_em = now()
       where id = v_parcela_id
         and upper(coalesce(status,'')) <> 'PAGO';

      if found then
        v_baixou := true;
        perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
        v_status := 'BAIXADO';
        v_motivo := null;
      else
        -- Zero linhas com o lock na mao e estado inesperado. O que NAO se pode
        -- fazer e chamar isso de BAIXADO: nada foi escrito.
        v_status := 'PARCELA_JA_PAGA';
        v_motivo := 'o UPDATE da baixa nao alterou nenhuma linha mesmo com o lock da'
          || ' parcela ' || v_parcela_id::text || ': estado inesperado, nada foi escrito.';
      end if;
    end if;
  end if;

  if not p_aplicar then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', v_status, 'motivo', v_motivo,
      'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
      'aplicou', false, 'baixou', false, 'evidencia', v_evid);
  end if;

  update public.pagamentos
     set status_conciliacao = v_status,
         conciliacao_motivo = v_motivo,
         conciliacao_em     = now()
   where id = p_pagamento_id;

  if v_status = 'BAIXADO' then
    update public.fila_pagamento_sem_vinculo
       set decisao = 'RESOLVIDO_AUTOMATICO',
           decidido_por = 'conciliacao@sistema',
           decidido_em = now(),
           status_conciliacao = 'BAIXADO',
           observacao = coalesce(observacao,'')
             || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'baixado automaticamente pela conciliacao'
     where pagamento_id = p_pagamento_id and decisao is null;

    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', v_status, 'motivo', null, 'parcela_id', v_parcela_id,
      'acordo_id', v_acordo_id, 'aplicou', true, 'baixou', v_baixou);
  end if;

  -- Pendente. Sugestoes por nome so quando o aluno ainda e desconhecido -- e
  -- continuam sendo SUGESTAO, nunca aplicadas.
  if v_pag.aluno_id is null and coalesce(trim(v_pag.aluno_nome),'') <> '' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', a.id, 'nome', a.nome, 'cpf_mascarado', a.cpf_mascarado,
             'matricula', a.matricula, 'tem_acordo_ativo',
             exists (select 1 from public.acordos ac where ac.aluno_id = a.id and ac.status='ATIVO'))), '[]'::jsonb)
      into v_sug
      from public.alunos a
     where coalesce(trim(a.nome),'') <> ''
       and translate(upper(regexp_replace(trim(a.nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
         = translate(upper(regexp_replace(trim(v_pag.aluno_nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
  end if;

  select i.arquivo_nome into v_arq from public.importacoes i where i.id = v_pag.importacao_id;

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
     valor_honorario, nome_recebido, cpf_recebido, matricula_recebida, sugestoes,
     motivo, status_conciliacao, evidencia_origem, evidencia_em)
  values (v_pag.id, v_pag.importacao_id, v_arq, v_pag.numero_parcela_completo, v_pag.data_pagamento,
          v_pag.valor_pago, v_pag.valor_honorario, v_pag.aluno_nome, v_pag.cpf, v_pag.matricula, v_sug,
          v_motivo || case when jsonb_array_length(v_sug) > 0
                           then ' | ' || jsonb_array_length(v_sug)::text || ' sugestao(oes) por nome, para conferencia humana'
                           else '' end,
          v_status, v_ev_origem, v_ev_em)
  on conflict (pagamento_id) do update
     set status_conciliacao = excluded.status_conciliacao,
         motivo = excluded.motivo,
         boleto = excluded.boleto,
         valor_pago = excluded.valor_pago,
         valor_honorario = excluded.valor_honorario,
         -- coalesce: evidencia gravada NUNCA e apagada por uma rodada que nao a recalculou
         evidencia_origem = coalesce(excluded.evidencia_origem, fila_pagamento_sem_vinculo.evidencia_origem),
         evidencia_em     = coalesce(excluded.evidencia_em, fila_pagamento_sem_vinculo.evidencia_em)
   where fila_pagamento_sem_vinculo.decisao is null;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
    'status', v_status, 'motivo', v_motivo,
    'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
    'aplicou', true, 'baixou', false, 'evidencia', v_evid);
end;
$motor$;

comment on function public.pagamento_conciliar_um(uuid, boolean) is
  'Motor unico da conciliacao. Decide, baixa quando a prova autoriza, carimba status_conciliacao/motivo/origem_baixa e mantem a fila. Sem acordo no CRM, consulta prime_portador_membro: presenca no portador 166 e negociacao comprovada (ACORDO_CONFIRMADO_SEM_ESTRUTURA); ausencia e inconclusiva, nunca prova negativa. p_aplicar=false e previa sem nenhum DML. Idempotente por origem_baixa_ref = pagamento_id e por nao rebaixar ACORDO_CONFIRMADO_SEM_ESTRUTURA.';

revoke all on function public.pagamento_conciliar_um(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. O CAMINHO AO VIVO -- identidade por CPF, evidencia do portador, e o motor
-- ---------------------------------------------------------------------------
--
-- Chamada pela `prime-portador` em modo pontual, DEPOIS de ela ja ter gravado a
-- filiacao em `prime_portador_membro`. A RPC nao fala com a Prime: quem fala e a
-- Edge Function, que tem a chave. Aqui so se registra e se reprocessa.
--
-- O VINCULO DE IDENTIDADE E POR CPF, e so por CPF. Nome nao vincula -- e a regra
-- da casa desde 08/09/2026, depois de 10 baixas erradas por nome. Se o CPF nao
-- achar exatamente UM aluno, a identidade NAO e tocada e o caso segue pendente.
--
-- E nao reescreve historico: pagamento que ja tem aluno_id mantem o
-- origem_vinculo que tinha -- os 11 vinculados a mao seguem GESTAO_MANUAL.

create or replace function public.conciliacao_confirmar_portador_166(
  p_pagamento_id uuid,
  p_cpf          text default null,
  p_origem       text default 'PRIME_API_LIVE'
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_pag record; v_cpf text; v_n int := 0; v_aluno uuid; v_vinculou boolean := false;
  v_r jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Confirmar portador e da gestao ou da rotina.' using errcode = '42501';
  end if;
  if coalesce(p_origem,'') not in ('PRIME_PORTADOR_MEMBRO','PRIME_API_LIVE') then
    raise exception 'origem invalida: %', p_origem using errcode = '22023';
  end if;

  select * into v_pag from public.pagamentos where id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  v_cpf := nullif(regexp_replace(coalesce(p_cpf, v_pag.cpf, ''), '\D', '', 'g'), '');
  if v_cpf is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_CPF');
  end if;

  -- IDENTIDADE POR CPF, exatamente um aluno. Dois ou nenhum: nao toca.
  if v_pag.aluno_id is null then
    select count(*), min(a.id::text)::uuid into v_n, v_aluno
      from public.alunos a
     where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0');

    if v_n = 1 then
      update public.pagamentos
         set aluno_id = v_aluno,
             cpf = coalesce(cpf, v_cpf),
             origem_vinculo = 'CPF',
             origem_vinculo_ref = lpad(v_cpf, 11, '0'),
             origem_vinculo_em = now()
       where id = p_pagamento_id;
      v_vinculou := true;
    end if;
  else
    -- ja vinculado: preserva origem_vinculo. So completa o CPF se faltava.
    update public.pagamentos set cpf = coalesce(cpf, v_cpf) where id = p_pagamento_id;
  end if;

  -- A evidencia do portador. So a origem e a data -- o resto ja tem coluna.
  update public.fila_pagamento_sem_vinculo
     set evidencia_origem = p_origem,
         evidencia_em = now()
   where pagamento_id = p_pagamento_id and decisao is null;

  -- E o motor unico decide. Nao ha UPDATE de status aqui.
  v_r := public.pagamento_conciliar_um(p_pagamento_id, true);

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
    'cpf_usado', lpad(v_cpf, 11, '0'), 'alunos_pelo_cpf', v_n,
    'vinculou_identidade', v_vinculou, 'origem_evidencia', p_origem,
    'conciliacao', v_r);
end;
$fn$;

comment on function public.conciliacao_confirmar_portador_166(uuid, text, text) is
  'Caminho ao vivo: registra a evidencia do portador 166, resolve identidade SOMENTE por CPF com aluno unico, e chama o motor unico. Nunca cria acordo ou parcela, nunca da baixa, nunca vincula por nome, e nao reescreve origem_vinculo de quem ja estava vinculado.';

grant execute on function public.conciliacao_confirmar_portador_166(uuid, text, text) to authenticated;
revoke all on function public.conciliacao_confirmar_portador_166(uuid, text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 5. PROVA
-- ---------------------------------------------------------------------------

do $prova$
declare v_n int;
begin
  if not exists (select 1 from pg_constraint c
                  where c.conrelid='public.pagamentos'::regclass
                    and pg_get_constraintdef(c.oid) ilike '%ACORDO_CONFIRMADO_SEM_ESTRUTURA%') then
    raise exception 'o estado novo nao entrou no CHECK';
  end if;

  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='fila_pagamento_sem_vinculo'
     and column_name in ('evidencia_origem','evidencia_em');
  if v_n <> 2 then raise exception 'as duas colunas de evidencia nao ficaram'; end if;

  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='pagamento_conciliar_um')
     not ilike '%prime_portador_membro%' then
    raise exception 'o motor nao consulta o espelho do portador';
  end if;

  -- idempotencia: o motor tem de parar antes de rebaixar o estado confirmado
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='pagamento_conciliar_um')
     not ilike '%= ''ACORDO_CONFIRMADO_SEM_ESTRUTURA'' then%' then
    raise exception 'o motor pode rebaixar ACORDO_CONFIRMADO_SEM_ESTRUTURA';
  end if;

  -- nada de criar acordo/parcela em lugar nenhum desta migration
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='conciliacao_confirmar_portador_166')
     ~* 'insert into public\.(acordos|parcelas)' then
    raise exception 'a RPC do caminho ao vivo cria acordo ou parcela';
  end if;

  if not has_function_privilege('authenticated',
       'public.conciliacao_confirmar_portador_166(uuid, text, text)'::regprocedure, 'EXECUTE') then
    raise exception 'a RPC do caminho ao vivo ficou sem EXECUTE para authenticated';
  end if;
  if has_function_privilege('anon',
       'public.conciliacao_confirmar_portador_166(uuid, text, text)'::regprocedure, 'EXECUTE') then
    raise exception 'a RPC do caminho ao vivo ficou aberta para anon';
  end if;
  if has_function_privilege('authenticated',
       'public.pagamento_conciliar_um(uuid, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'o motor ficou chamavel por authenticated';
  end if;

  -- importar_acordos e parcelas_amarrar_boleto continuam intocadas
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='importar_acordos') ilike '%conciliacao_%' then
    raise exception 'importar_acordos foi alterada';
  end if;
  if not exists (select 1 from pg_proc where proname='parcelas_amarrar_boleto') then
    raise exception 'parcelas_amarrar_boleto sumiu';
  end if;
end $prova$;
