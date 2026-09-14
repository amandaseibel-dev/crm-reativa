-- ROLLBACK de 20260914190000_acordo_confirmado_sem_estrutura.sql
--
-- EXECUTAVEL DE PONTA A PONTA: roda inteiro, sem meta-comando de psql e sem
-- passo manual. O corpo do motor abaixo e copia byte a byte de
-- supabase/migrations/20260914170000_motor_unico_de_conciliacao.sql -- a versao
-- que esta em producao como 20260914144734.
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO:
--   * nao apaga `evidencia_origem` nem `evidencia_em`. Coluna com evidencia
--     gravada nao se derruba para desfazer regra -- o registro de que a
--     negociacao foi comprovada continua valendo mesmo sem a regra;
--   * nao desfaz vinculo de identidade. Quem foi vinculado por CPF continua
--     vinculado: o CPF nao deixou de ser verdade;
--   * nao desfaz baixa nenhuma -- esta migration nunca baixou nada;
--   * nao toca `prime_portador_membro`, `importar_acordos`,
--     `parcelas_amarrar_boleto` nem `acordo_reconstruir_cron`.
--
-- ATENCAO: depois deste rollback, os pagamentos com negociacao comprovada
-- voltam a aparecer como `AGUARDANDO_ACORDO` -- pendencia que ninguem consegue
-- resolver, porque o acordo nunca vira em relatorio nenhum.

-- ---------------------------------------------------------------------------
-- 1. Normalizar as linhas antes de estreitar o CHECK
-- ---------------------------------------------------------------------------
-- Sem isto o CHECK antigo nao volta. O estado anterior destes pagamentos era
-- AGUARDANDO_ACORDO, e o motivo guarda o que se sabia.

update public.pagamentos
   set status_conciliacao = 'AGUARDANDO_ACORDO',
       conciliacao_motivo = coalesce(conciliacao_motivo,'')
         || ' | [rollback 20260914190000: estava ACORDO_CONFIRMADO_SEM_ESTRUTURA'
         || ' -- negociacao comprovada no portador 166, evidencia preservada na fila]'
 where status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';

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
        'BAIXADO','AGUARDANDO_ACORDO','AGUARDANDO_AMARRACAO',
        'PARCELA_JA_PAGA','REVISAO','SEM_VINCULO'
      ));
end $ajuste$;

-- ---------------------------------------------------------------------------
-- 2. O motor volta a versao anterior
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

revoke all on function public.pagamento_conciliar_um(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Sai a RPC do caminho ao vivo
-- ---------------------------------------------------------------------------
-- Tem EXECUTE para authenticated; sem o desenho novo nao tem funcao e nao deve
-- continuar exposta.

drop function if exists public.conciliacao_confirmar_portador_166(uuid, text, text);

-- ---------------------------------------------------------------------------
-- 4. PROVA DO ROLLBACK
-- ---------------------------------------------------------------------------

do $prova$
begin
  if exists (select 1 from public.pagamentos
              where status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA') then
    raise exception 'sobrou pagamento no estado que o CHECK antigo nao aceita';
  end if;
  if exists (select 1 from pg_constraint c
              where c.conrelid='public.pagamentos'::regclass
                and pg_get_constraintdef(c.oid) ilike '%ACORDO_CONFIRMADO_SEM_ESTRUTURA%') then
    raise exception 'o CHECK nao voltou aos seis valores';
  end if;
  if exists (select 1 from pg_proc where proname='conciliacao_confirmar_portador_166') then
    raise exception 'a RPC do caminho ao vivo continua no banco';
  end if;
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='pagamento_conciliar_um')
     ilike '%prime_portador_membro%' then
    raise exception 'o motor nao voltou: ainda consulta o espelho do portador';
  end if;
  -- a evidencia FICA
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='fila_pagamento_sem_vinculo'
                    and column_name='evidencia_origem') then
    raise exception 'a coluna de evidencia foi apagada -- nao deveria';
  end if;
end $prova$;
