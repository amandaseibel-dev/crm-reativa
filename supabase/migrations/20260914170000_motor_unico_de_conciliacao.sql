-- MOTOR UNICO DE CONCILIACAO.
--
-- O QUE ESTAVA ERRADO: DOIS MOTORES, E O SEGUNDO NAO SABIA DO PRIMEIRO.
--
--   INSERT pagamento -> trg_pagamento_conciliar -> escada -> baixa + status + fila
--   cron :40 -> fluxo_pagamentos_rodar
--                 -> parcelas_amarrar_boleto()        grava parcelas.boleto
--                 -> acordos_pos_importacao()
--                 -> baixa_pelo_relatorio_pagamento() SEGUNDA escada -> baixa
--                                                     e NAO toca status_conciliacao
--
-- Resultado: a rotina horaria baixava a parcela por fora e o pagamento ficava
-- marcado AGUARDANDO_ACORDO para sempre. Pendencia falsa na tela, e duas
-- implementacoes da mesma regra de baixa para manter em sincronia.
--
-- O QUE ESTA MIGRATION FAZ: cria UM motor, `pagamento_conciliar_um`, e faz
-- todos os caminhos terminarem nele.
--
--   trigger do INSERT ............ casca de uma linha
--   cron horario ................. baixa_pelo_relatorio_pagamento delega
--   fim de importar_acordos ...... conciliacao_reprocessar
--   vinculo manual da gestao ..... pagamento_vincular_aluno delega
--
-- FRONTEIRA PROSPECTIVA, EXPLICITA. O reprocessamento automatico so enxerga
-- `status_conciliacao IS NOT NULL` e diferente de BAIXADO. Os ~9.000 pagamentos
-- historicos tem status NULL e ficam INVISIVEIS para o motor: nao sao
-- reclassificados, nao sao baixados, nao entram na fila. Isso tambem impede que
-- a delegacao de `baixa_pelo_relatorio_pagamento` vire backfill historico --
-- o escopo largo dela passa a exigir um parametro explicito.
--
-- EVIDENCIA CANONICA DA BAIXA AUTOMATICA: `parcelas.origem_baixa`,
-- `origem_baixa_ref = pagamento_id`, `origem_baixa_em`. Decisao da gestao em
-- 14/09/2026: esta migration NAO insere em `baixas_pagamento`. Medido antes de
-- decidir: 1.924 das 4.430 parcelas PAGO (43%) ja nao tem linha vigente la, 11
-- parcelas tem baixa duplicada, nao existe UNIQUE em parcela_id, e a tabela e
-- lida por 18 funcoes -- povoa-la mudaria `honorarios_a_entrar` (que cai em
-- `p.honorarios` quando nao ha linha) e `acordos_sinalizar_boleto_repetido`
-- (que usa a ausencia de baixa como condicao para sinalizar duplicado).
-- Historico, duplicatas e consumidores dessa tabela ficam intocados.
--
-- A ESCADA DA BAIXA. Copia literal da versao vigente em producao -- ledger
-- 20260912121649__fase2b_origem_baixa_no_gatilho_e_invariante_novo.sql --
-- inclusive os tres carimbos de origem_baixa. Duas condicoes NOVAS entram, e
-- ambas so RESTRINGEM:
--
--   1. idempotencia: se a parcela ja foi baixada POR ESTE pagamento
--      (origem_baixa_ref = pagamento_id), devolve BAIXADO sem escrever nada;
--   2. amarracao fraca exige unicidade: com `boleto_confiavel = false`, nao
--      basta o vencimento bater. O motor exige que exista EXATAMENTE UMA
--      parcela candidata no acordo -- nao paga/cancelada, vencimento a +-3 dias
--      do vencimento do Santander, valor na faixa -- e que essa candidata seja
--      justamente a parcela onde o boleto esta amarrado. Zero ou duas ou mais:
--      REVISAO.
--
-- Medido em 14/09: seis dos nove boletos que baixariam estao sobre amarracao
-- com `boleto_confiavel = false`, incluindo o canario 50676780002. O portao nao
-- e teorico.
--
-- `parcelas_amarrar_boleto()` NAO E TOCADA. Ela continua amarrando pelas
-- ancoras (aluno + vencimento +-3 + valor), continua aprendendo deslocamento a
-- partir de boleto confiavel e continua com o fallback legado por sufixo. O que
-- muda e QUEM CONFIA NELA: o portao desce para o motor.
--
-- PARCELA_JA_PAGA NAO FECHA SOZINHA nesta versao. Nunca ha segunda baixa, a
-- evidencia da baixa anterior e computada e escrita no motivo, e a linha fica
-- disponivel para conferencia -- mas so sai da fila por decisao humana, via
-- `conciliacao_encerrar`. Automatizar o fechamento aqui seria automatizar risco
-- de pagamento duplicado.
--
-- PREVIA SEM DML. `p_aplicar => false` decide e devolve o resultado sem
-- escrever nada: nem parcela, nem pagamento, nem fila, nem auditoria.

-- ---------------------------------------------------------------------------
-- 0. A FILA PASSA A ACEITAR AS DUAS DECISOES NOVAS
-- ---------------------------------------------------------------------------

do $ajuste$
declare v_con text;
begin
  select c.conname into v_con
    from pg_constraint c
   where c.conrelid = 'public.fila_pagamento_sem_vinculo'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%decisao%';

  if v_con is not null then
    execute format('alter table public.fila_pagamento_sem_vinculo drop constraint %I', v_con);
  end if;

  alter table public.fila_pagamento_sem_vinculo
    add constraint fila_pagamento_sem_vinculo_decisao_check
    check (decisao is null or decisao in (
      'VINCULADO',              -- gestao escolheu o aluno
      'DESCARTADO',
      'AGUARDANDO_TERCEIRO',
      'RESOLVIDO_AUTOMATICO',   -- o motor baixou: a pendencia acabou sozinha
      'ENCERRADO_GESTAO'        -- gestao conferiu e encerrou sem baixa
    ));
end $ajuste$;

-- ---------------------------------------------------------------------------
-- 1. O MOTOR
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
          v_status := 'AGUARDANDO_ACORDO';
          v_motivo := 'boleto ' || v_pag.numero_parcela_completo
            || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM';
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

    -- O cron das :40 e um clique na tela podem cair na mesma parcela no mesmo
    -- segundo. O lock morre com a transacao.
    perform pg_advisory_xact_lock(hashtextextended(v_parcela.id::text, 0));

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
     where id = v_parcela.id
       and upper(coalesce(status,'')) <> 'PAGO';

    if found then
      v_baixou := true;
      perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
    end if;
    v_status := 'BAIXADO';
    v_motivo := null;
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
     motivo, status_conciliacao)
  values (v_pag.id, v_pag.importacao_id, v_arq, v_pag.numero_parcela_completo, v_pag.data_pagamento,
          v_pag.valor_pago, v_pag.valor_honorario, v_pag.aluno_nome, v_pag.cpf, v_pag.matricula, v_sug,
          v_motivo || case when jsonb_array_length(v_sug) > 0
                           then ' | ' || jsonb_array_length(v_sug)::text || ' sugestao(oes) por nome, para conferencia humana'
                           else '' end,
          v_status)
  on conflict (pagamento_id) do update
     set status_conciliacao = excluded.status_conciliacao,
         motivo = excluded.motivo,
         boleto = excluded.boleto,
         valor_pago = excluded.valor_pago,
         valor_honorario = excluded.valor_honorario
   where fila_pagamento_sem_vinculo.decisao is null;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
    'status', v_status, 'motivo', v_motivo,
    'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
    'aplicou', true, 'baixou', false, 'evidencia', v_evid);
end;
$motor$;

comment on function public.pagamento_conciliar_um(uuid, boolean) is
  'Motor unico da conciliacao. Decide, baixa quando a prova autoriza, carimba status_conciliacao/motivo/origem_baixa e mantem a fila. p_aplicar=false e previa sem nenhum DML. Idempotente por origem_baixa_ref = pagamento_id.';

revoke all on function public.pagamento_conciliar_um(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. O GATILHO DO INSERT VIRA CASCA
-- ---------------------------------------------------------------------------

create or replace function public._pagamento_conciliar()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
begin
  perform public.pagamento_conciliar_um(new.id, true);
  return null;
end;
$fn$;

revoke all on function public._pagamento_conciliar() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. REPROCESSAMENTO -- SOMENTE O QUE E PROSPECTIVO E PENDENTE
-- ---------------------------------------------------------------------------

create or replace function public.conciliacao_reprocessar(
  p_aplicar boolean default true,
  p_limite  int default 5000
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_id uuid; v_r jsonb; v_res jsonb := '{}'::jsonb; v_n int := 0; v_baixou int := 0;
  v_conta jsonb := '{}'::jsonb; v_st text;
begin
  for v_id in
    select p.id
      from public.pagamentos p
     -- A FRONTEIRA. status_conciliacao NULL = entrou antes de 14/09/2026:
     -- invisivel para o motor automatico, por decisao. Nao reclassifica, nao
     -- baixa, nao enfileira.
     where p.status_conciliacao is not null
       and p.status_conciliacao <> 'BAIXADO'
       -- o que a gestao ja decidiu nao volta sozinho para a fila
       and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                        where f.pagamento_id = p.id and f.decisao is not null)
     order by p.data_pagamento, p.id
     limit greatest(coalesce(p_limite, 5000), 0)
  loop
    v_r := public.pagamento_conciliar_um(v_id, p_aplicar);
    v_n := v_n + 1;
    v_st := coalesce(v_r->>'status','?');
    v_conta := jsonb_set(v_conta, array[v_st],
                         to_jsonb(coalesce((v_conta->>v_st)::int, 0) + 1), true);
    if coalesce((v_r->>'baixou')::boolean, false) then v_baixou := v_baixou + 1; end if;
  end loop;

  v_res := jsonb_build_object('modo', case when p_aplicar then 'aplicado' else 'previa' end,
                              'avaliados', v_n, 'baixados', v_baixou, 'por_status', v_conta);
  return v_res;
end;
$fn$;

comment on function public.conciliacao_reprocessar(boolean, int) is
  'Reprocessa os pagamentos PENDENTES e PROSPECTIVOS (status_conciliacao nao nulo e diferente de BAIXADO) pelo motor unico. Historico com status NULL fica intocado. p_aplicar=false e previa sem DML.';

revoke all on function public.conciliacao_reprocessar(boolean, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. `baixa_pelo_relatorio_pagamento` DEIXA DE TER REGRA PROPRIA
-- ---------------------------------------------------------------------------
--
-- Ela continua sendo a etapa `baixa_pelo_relatorio` do fluxo horario -- o cron
-- e o `fluxo_pagamentos_rodar` nao sao tocados. O que sai e a SEGUNDA
-- implementacao da regra de baixa: o corpo vira uma chamada ao motor.
--
-- `p_incluir_historicos` existe para que a delegacao NAO vire backfill: no
-- default, a funcao enxerga exatamente o que o motor enxerga. Varrer o
-- historico passa a ser um ato deliberado da gestao, nunca efeito colateral do
-- cron. `p_desde` continua aceito para nao quebrar a chamada existente
-- `baixa_pelo_relatorio_pagamento(true, current_date - 180)`.

create or replace function public.baixa_pelo_relatorio_pagamento(
  p_confirmar boolean default false,
  p_desde date default '2026-07-01'::date,
  p_incluir_historicos boolean default false
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '600s'
as $fn$
declare v_r jsonb;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  if coalesce(p_incluir_historicos, false) then
    raise exception 'Varredura historica nao e mais efeito colateral do cron. '
      'Pagamentos com status_conciliacao NULL sao anteriores a 14/09/2026 e '
      'exigem decisao explicita da gestao, em chamada propria.'
      using errcode = '0A000';
  end if;

  v_r := public.conciliacao_reprocessar(coalesce(p_confirmar, false), 5000);
  return v_r || jsonb_build_object('delegado_para', 'pagamento_conciliar_um', 'desde', p_desde);
end;
$fn$;

comment on function public.baixa_pelo_relatorio_pagamento(boolean, date, boolean) is
  'Etapa do fluxo horario. Desde 14/09/2026 NAO tem regra propria: delega ao motor unico pagamento_conciliar_um. Escopo prospectivo; historico exige ato deliberado.';

revoke all on function public.baixa_pelo_relatorio_pagamento(boolean, date, boolean) from public, anon;
grant execute on function public.baixa_pelo_relatorio_pagamento(boolean, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. O VINCULO MANUAL TAMBEM TERMINA NO MOTOR
-- ---------------------------------------------------------------------------
--
-- Antes, `pagamento_vincular_aluno` fechava a linha da fila assim que a gestao
-- escolhia o aluno. Isso estava certo enquanto a fila significava "nao sei de
-- quem e o dinheiro". Depois de 14/09 a fila significa "a parcela nao baixou",
-- e escolher o aluno nao baixa parcela nenhuma: o pagamento sumia da tela com a
-- pendencia intacta. Agora a fila so fecha se o motor disser BAIXADO.

create or replace function public.pagamento_vincular_aluno(
  p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_nome text; v_cpf text; v_ant uuid; v_email text; v_fila int := 0; v_r jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select a.nome, a.cpf into v_nome, v_cpf from public.alunos a where a.id = p_aluno_id;
  if v_nome is null then
    return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
  end if;

  select aluno_id into v_ant from public.pagamentos where id = p_pagamento_id;

  update public.pagamentos
     set aluno_id = p_aluno_id,
         cpf = coalesce(cpf, v_cpf),
         origem_vinculo = 'GESTAO_MANUAL',
         origem_vinculo_ref = v_email,
         origem_vinculo_em = now()
   where id = p_pagamento_id;

  -- Reconciliar DEPOIS de vincular: o aluno novo pode destravar a baixa.
  v_r := public.pagamento_conciliar_um(p_pagamento_id, true);

  -- A fila so fecha por vinculo quando a conciliacao terminou. Se ainda falta
  -- acordo, amarracao ou revisao, a linha continua aberta -- com o motivo novo.
  if coalesce(v_r->>'status','') = 'BAIXADO' then
    update public.fila_pagamento_sem_vinculo
       set decisao = 'VINCULADO',
           aluno_escolhido_id = p_aluno_id,
           decidido_por = v_email,
           decidido_em = now(),
           observacao = p_observacao
     where pagamento_id = p_pagamento_id and decisao is null;
    get diagnostics v_fila = row_count;
  else
    update public.fila_pagamento_sem_vinculo
       set aluno_escolhido_id = p_aluno_id,
           observacao = coalesce(p_observacao, observacao)
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'PAGAMENTO_VINCULADO',
          'Pagamento vinculado manualmente pela gestao.'
          || case when p_observacao is null then '' else ' ' || p_observacao end,
          v_email, v_email, now());

  return jsonb_build_object('ok', true, 'aluno_nome', v_nome,
                            'aluno_id_anterior', v_ant, 'fila_fechada', v_fila,
                            'conciliacao', v_r);
end;
$fn$;

grant execute on function public.pagamento_vincular_aluno(uuid, uuid, text) to authenticated;
revoke all on function public.pagamento_vincular_aluno(uuid, uuid, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 6. ENCERRAMENTO SIMPLES PELA GESTAO
-- ---------------------------------------------------------------------------
--
-- PARCELA_JA_PAGA nao fecha sozinha nesta versao. Este e o caminho humano: a
-- gestao confere a evidencia da baixa anterior e encerra. Nao baixa nada, nao
-- altera parcela, nao altera valor -- so tira da fila, com registro de quem.

create or replace function public.conciliacao_encerrar(
  p_pagamento_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_email text; v_n int := 0; v_st text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerrar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO');
  end if;
  if v_st = 'BAIXADO' then
    return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO');
  end if;

  update public.fila_pagamento_sem_vinculo
     set decisao = 'ENCERRADO_GESTAO',
         decidido_por = v_email,
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'encerrado pela gestao'
           || case when p_observacao is null then '' else ': ' || p_observacao end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n);
end;
$fn$;

grant execute on function public.conciliacao_encerrar(uuid, text) to authenticated;
revoke all on function public.conciliacao_encerrar(uuid, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 7. ACORDO NOVO REAVALIA OS PAGAMENTOS QUE ESPERAVAM POR ELE
-- ---------------------------------------------------------------------------
--
-- Substituicao CIRURGICA em `importar_acordos`: insere UMA chamada imediatamente
-- antes do UPDATE final, mantendo todo o resto byte a byte. O padrao e o mesmo
-- de 20260912121649 com `invariantes_rodar` -- ler o corpo de producao e trocar
-- um marcador e o que evita reescrever uma funcao de 120 linhas a partir de uma
-- copia do repositorio que pode ter drift.
--
-- NAO forca baixa. O motor reavalia do zero: se as parcelas do acordo novo
-- nasceram sem boleto, AGUARDANDO_ACORDO vira AGUARDANDO_AMARRACAO, nao BAIXADO.

do $cirurgia$
declare
  v_src text; v_novo text;
  v_marcador text := '  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;';
  v_bloco text;
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'importar_acordos';

  if v_src is null then
    raise exception 'importar_acordos nao encontrada -- abortando sem tocar nada';
  end if;
  if position(v_marcador in v_src) = 0 then
    raise exception 'marcador do update de importacoes nao encontrado -- abortando sem tocar a funcao';
  end if;
  if position('conciliacao_reprocessar' in v_src) > 0 then
    raise notice 'importar_acordos ja chama a conciliacao; nada a fazer';
    return;
  end if;

  v_bloco := E'  -- Acordo novo no CRM pode ser exatamente o que faltava para um pagamento\n'
          || E'  -- que ja entrou e ficou em AGUARDANDO_ACORDO. Reavalia -- sem forcar baixa:\n'
          || E'  -- parcela sem boleto vira AGUARDANDO_AMARRACAO, nao BAIXADO.\n'
          || E'  perform public.conciliacao_reprocessar(true, 2000);\n\n';

  v_novo := replace(v_src, v_marcador, v_bloco || v_marcador);

  execute format(
    'create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
       returns json language plpgsql security definer
       set search_path to ''public''
       set statement_timeout to ''180000''
       as %s', quote_literal(v_novo));
end $cirurgia$;

-- ---------------------------------------------------------------------------
-- 8. PROVA
-- ---------------------------------------------------------------------------

do $prova$
declare v_n int;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='pagamento_conciliar_um') then
    raise exception 'o motor nao foi criado';
  end if;

  -- o gatilho do INSERT tem de ser casca: nenhuma regra de baixa dentro dele
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='_pagamento_conciliar')
     ilike '%update public.parcelas%' then
    raise exception 'o gatilho voltou a ter regra propria de baixa';
  end if;
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='_pagamento_conciliar')
     not ilike '%pagamento_conciliar_um%' then
    raise exception 'o gatilho nao delega para o motor';
  end if;

  -- baixa_pelo_relatorio_pagamento nao pode mais escrever em parcelas
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='baixa_pelo_relatorio_pagamento')
     ilike '%update public.parcelas%' then
    raise exception 'baixa_pelo_relatorio_pagamento continua com regra propria';
  end if;

  -- a fronteira prospectiva tem de estar no reprocessador
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='conciliacao_reprocessar')
     not ilike '%status_conciliacao is not null%' then
    raise exception 'o reprocessador perdeu a fronteira prospectiva';
  end if;

  -- um unico AFTER INSERT de conciliacao
  select count(*) into v_n from pg_trigger
   where tgrelid='public.pagamentos'::regclass and not tgisinternal
     and tgname='trg_pagamento_conciliar';
  if v_n <> 1 then raise exception 'trg_pagamento_conciliar nao ficou exatamente uma vez'; end if;

  -- parcelas_amarrar_boleto continua intacta e existente
  if not exists (select 1 from pg_proc where proname='parcelas_amarrar_boleto') then
    raise exception 'parcelas_amarrar_boleto sumiu -- ela nao deveria ser tocada';
  end if;

  -- o motor nao pode ser chamavel de fora
  if has_function_privilege('authenticated', 'public.pagamento_conciliar_um(uuid, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'o motor ficou chamavel por authenticated';
  end if;

  -- a fila tem de aceitar as duas decisoes novas
  if not exists (select 1 from pg_constraint c
                  where c.conrelid='public.fila_pagamento_sem_vinculo'::regclass
                    and pg_get_constraintdef(c.oid) ilike '%RESOLVIDO_AUTOMATICO%') then
    raise exception 'a fila nao aceita RESOLVIDO_AUTOMATICO';
  end if;

  -- importar_acordos tem de reavaliar no fim
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='importar_acordos')
     not ilike '%conciliacao_reprocessar%' then
    raise exception 'importar_acordos nao reavalia a conciliacao';
  end if;
end $prova$;
