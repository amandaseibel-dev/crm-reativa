-- TITULO ORIGINAL LIQUIDADO NA ORIGEM (Prime), sem reconstruir acordo.
--
-- DEPENDE de 20260914190000_acordo_confirmado_sem_estrutura.sql (PR #379):
-- reusa o motor unico, o disparador do caminho ao vivo e o CHECK de
-- `status_conciliacao`. Aplicar depois dela, nunca antes.
--
-- O PROBLEMA. Ha pagamento Santander de acordo que o CRM nao tem. A estrutura
-- do acordo nao vem da Prime -- medido em 53 alunos, 1.327 linhas de extrato:
-- `agreements` volta vazio para todos, inclusive para acordos que o CRM sabe
-- ATIVOS, e `isAgreementInstallment` nunca e true. Entao reconstruir parcela e
-- impossivel sem inventar, e inventar esta proibido.
--
-- O QUE A PRIME DA, E E VERDADE VERIFICAVEL: o estado do TITULO ORIGINAL. A
-- ponte foi medida: `financialStatement[].boleto` (7 digitos) e exatamente
-- `acordos_titulos.documento`. Nos 13 pendentes, os 46 titulos do portador 195
-- aparecem liquidados no Prime -- varios em 11/09 e 14/09, as datas dos
-- proprios pagamentos Santander -- enquanto 17 seguem `em_aberto` aqui.
--
-- ENTAO ESTA MIGRATION FAZ UMA COISA SO: conclui o TITULO. Nao cria acordo,
-- nao cria parcela, nao infere quantidade de parcelas, e nao le dinheiro do
-- Prime. O caixa continua sendo o do Santander, intocado.
--
-- TRES SINAIS, TRES SIGNIFICADOS -- e nenhum vira o outro:
--
--   status do titulo no Prime  -> a divida-mae foi liquidada na ULBRA
--   pagamento Santander        -> entrou dinheiro, com valor e honorario
--   presenca no portador 166   -> houve negociacao
--
-- Esta migration escreve SOMENTE o primeiro, e carimba a origem para que
-- ninguem leia um pelo outro depois.

-- ---------------------------------------------------------------------------
-- 1. AS TRES MARCAS DA LIQUIDACAO OFICIAL
-- ---------------------------------------------------------------------------
--
-- Espelham o que `parcelas` ja tem (`origem_baixa`/`_ref`/`_em`). Sao a chave
-- de idempotencia e a unica forma de, depois, distinguir este titulo de um
-- pago no caixa da ULBRA -- que e outra coisa, e nao pode ser confundida.

alter table public.acordos_titulos
  add column if not exists origem_liquidacao     text,
  add column if not exists origem_liquidacao_ref text,
  add column if not exists origem_liquidacao_em  timestamptz;

do $ol$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'acordos_titulos_origem_liquidacao_valida') then
    alter table public.acordos_titulos
      add constraint acordos_titulos_origem_liquidacao_valida check (
        origem_liquidacao is null or origem_liquidacao in ('PRIME_LIQUIDACAO_OFICIAL'));
  end if;
end $ol$;

comment on column public.acordos_titulos.origem_liquidacao is
  'PRIME_LIQUIDACAO_OFICIAL: o titulo foi concluido porque a Prime registra o documento liquidado no portador 195. NAO significa dinheiro recebido pela ULBRA nem parcela de acordo baixada -- o caixa e o do Santander, em pagamentos.';
comment on column public.acordos_titulos.origem_liquidacao_ref is
  'pagamentos.id que motivou a liquidacao. Chave de idempotencia: preenchido, o titulo nao e reprocessado.';
comment on column public.acordos_titulos.origem_liquidacao_em is
  'Quando o CRM concluiu o titulo a partir da evidencia da Prime.';

-- ---------------------------------------------------------------------------
-- 2. A TRAVA: LIQUIDADO NA ORIGEM E TERMINAL
-- ---------------------------------------------------------------------------
--
-- Exigencia da gestao: importacao futura de acordo pode registrar historico e
-- estrutura, mas NAO pode devolver esta divida ao saldo nem desfazer o
-- PAGO/quitada.
--
-- POR QUE UM TRIGGER, E NAO UM REMENDO EM CADA FUNCAO. Existem hoje 17 funcoes
-- em producao que escrevem `acordos_titulos`, e quatro delas reabrem titulo
-- (`titulo_reavaliar`, `acordo_cancelar`, `desvincular_titulos_acordo`,
-- `acordos_pos_importacao`). Remendar uma a uma deixaria de fora as que eu nao
-- listei e as que ainda vao existir -- e a regra e "qualquer importacao
-- futura". No trigger a trava vale para todo mundo, inclusive para o que for
-- escrito depois de mim.
--
-- E ELA COAGE, NAO EXPLODE. Levantar excecao aqui derrubaria a importacao de
-- acordos inteira por causa de um titulo -- transformaria uma protecao em
-- incidente. Entao o UPDATE passa, o acordo pode ser gravado no titulo para
-- historico, e so os campos que definem "isto e divida aberta" sao mantidos.

create or replace function public.titulo_liquidado_na_origem_e_terminal()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_tentou text;
begin
  if coalesce(old.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL' then
    return new;
  end if;

  -- As tres marcas nao se apagam: sao a prova de POR QUE o titulo fechou.
  new.origem_liquidacao     := old.origem_liquidacao;
  -- O VELHO VENCE. Nao e coalesce do novo: uma segunda execucao concorrente
  -- chega com OUTRO pagamento em `new`, e deixar o novo ganhar reescreveria a
  -- proveniencia -- o titulo passaria a dizer que foi liquidado por um
  -- pagamento que nao foi o que o liquidou. Gravada uma vez, nao troca mais.
  new.origem_liquidacao_ref := coalesce(old.origem_liquidacao_ref, new.origem_liquidacao_ref);
  new.origem_liquidacao_em  := coalesce(old.origem_liquidacao_em,  new.origem_liquidacao_em);

  if coalesce(new.situacao,'') = 'PAGO' and coalesce(new.status,'') = 'quitada' then
    return new;   -- nada a coagir; segue a vida (acordo_id, motivo, etc.)
  end if;

  v_tentou := coalesce(new.situacao,'(null)') || '/' || coalesce(new.status,'(null)');
  new.situacao := 'PAGO';
  new.status   := 'quitada';
  new.motivo_ajuste := coalesce(new.motivo_ajuste,'')
    || case when coalesce(new.motivo_ajuste,'') = '' then '' else ' | ' end
    || 'tentativa de reabrir titulo liquidado na origem (' || v_tentou
    || ') recusada: a divida ja foi concluida pela liquidacao oficial na Prime';

  -- So registra quando REALMENTE impediu alguma coisa -- e raro, e por isso cabe.
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id::text,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$fn$;

comment on function public.titulo_liquidado_na_origem_e_terminal() is
  'Trava de mao unica: titulo com origem_liquidacao = PRIME_LIQUIDACAO_OFICIAL nunca volta a ser divida aberta. Coage situacao/status de volta para PAGO/quitada em vez de levantar excecao, para que a importacao de acordos nao quebre -- o acordo pode ser gravado no titulo para historico, so a divida nao ressuscita.';

drop trigger if exists trg_titulo_liquidado_na_origem_e_terminal on public.acordos_titulos;
create trigger trg_titulo_liquidado_na_origem_e_terminal
before update on public.acordos_titulos
for each row execute function public.titulo_liquidado_na_origem_e_terminal();

-- ---------------------------------------------------------------------------
-- 3. O ESTADO NOVO DO PAGAMENTO
-- ---------------------------------------------------------------------------
--
-- Nao e `BAIXADO`: esse continua significando "parcela de acordo baixada", e
-- aqui nenhuma parcela foi tocada. Nao e `AGUARDANDO_ACORDO`: a conciliacao
-- possivel foi resolvida -- a divida-mae fechou, e o acordo pode nunca entrar
-- no CRM. E um desfecho proprio, e diz exatamente o que aconteceu.

do $ajuste$
begin
  alter table public.pagamentos drop constraint if exists pagamentos_status_conciliacao_valido;
  alter table public.pagamentos
    add constraint pagamentos_status_conciliacao_valido check (
      status_conciliacao is null or status_conciliacao in (
        'BAIXADO',
        'AGUARDANDO_ACORDO',
        'AGUARDANDO_AMARRACAO',
        'PARCELA_JA_PAGA',
        'REVISAO',
        'SEM_VINCULO',
        'ACORDO_CONFIRMADO_SEM_ESTRUTURA',  -- negociacao provada no 166, acordo ausente no CRM
        'TITULO_ORIGINAL_LIQUIDADO'         -- o titulo-mae fechou na Prime; nenhum acordo ou parcela criado
      ));
end $ajuste$;

-- ---------------------------------------------------------------------------
-- 4. O MOTOR RECONHECE O ESTADO TERMINAL
-- ---------------------------------------------------------------------------
--
-- Copia integral de 20260914190000, com UMA insercao: a saida antecipada para
-- `TITULO_ORIGINAL_LIQUIDADO`. Nenhuma outra linha muda.

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
  -- concordancia entre o numero do acordo do arquivo e o prefixo do boleto
  v_tit text; v_acordo_do_boleto text; v_concorda boolean; v_estrutura text;
begin
  select * into v_pag from public.pagamentos where id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  v_chave := ltrim(coalesce(v_pag.numero_parcela_completo,''),'0');
  v_venc  := public.vencimento_do_pagamento(v_pag.dados);

  -- ESTADO TERMINAL, ANTES DE QUALQUER RECLASSIFICACAO.
  -- O titulo original ja foi concluido pela liquidacao oficial na Prime. Nada
  -- que este motor saiba olhar -- parcela, acordo, portador -- pode desfazer
  -- isso, e reclassificar so devolveria o pagamento para uma pendencia que ja
  -- tem resposta. Sai aqui, sem escrever.
  if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', 'TITULO_ORIGINAL_LIQUIDADO', 'aplicou', false,
      'motivo', 'estado terminal: o titulo original ja foi concluido pela liquidacao oficial na Prime');
  end if;

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

          -- CONCORDANCIA SANTANDER. O arquivo traz o numero do acordo DUAS vezes:
          -- na coluna C (`titulo_numero`) e dentro do boleto (posicoes 2 a 7).
          -- Medido em 14/09: batem em 13 de 13 divergentes. Promover sem essa
          -- concordancia seria confirmar negociacao a partir de UMA leitura so --
          -- e a regra da casa e nunca decidir com uma variavel unica.
          -- O sufixo do boleto continua sem significado: nao e numero de parcela.
          v_acordo_do_boleto := ltrim(v_pref, '0');
          v_tit := nullif(ltrim(regexp_replace(coalesce(v_pag.titulo_numero,''), '\D', '', 'g'), '0'), '');
          v_concorda := (v_tit is not null and v_tit = v_acordo_do_boleto);

          -- O FALLBACK E FALLBACK, E DEPENDE DO RESULTADO -- NAO DA TENTATIVA.
          -- Estar no portador 166 prova que houve negociacao; nao prova que a
          -- estrutura nao existe. E "tentei" nao e resposta: so
          -- NAO_ENCONTRADA -- /agreements respondeu JSON valido e veio vazio --
          -- autoriza dizer "sem estrutura". ENCONTRADA significa que ha
          -- estrutura e ela ainda nao foi capturada; ERRO significa que nao se
          -- sabe; NULL, que ninguem perguntou. Nenhum dos tres promove.
          select f.consulta_estrutura_resultado into v_estrutura
            from public.fila_pagamento_sem_vinculo f
           where f.pagamento_id = p_pagamento_id;

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
                         where lpad(m.cpf,11,'0') = lpad(v_cpf_pag,11,'0') and m.portador = 166)
            and coalesce(v_estrutura,'') = 'NAO_ENCONTRADA' then

            if not v_concorda then
              -- Evidencia positiva de negociacao, mas o arquivo se contradiz. Nao se
              -- confirma acordo cujo numero o proprio arquivo discorda -- vai para
              -- conferencia humana, sem inferir qual dos dois esta certo.
              v_status := 'REVISAO';
              v_motivo := 'o aluno esta no portador 166 (negociacao comprovada), mas o'
                || ' numero do acordo nao concorda no arquivo: titulo_numero '
                || coalesce(nullif(v_pag.titulo_numero,''),'(ausente)')
                || ' x prefixo do boleto ' || v_acordo_do_boleto
                || '. Nao confirmado -- conferir qual e o acordo.';
            else
              select max(m.coletado_em) into v_ev_em
                from public.prime_portador_membro m
               where lpad(m.cpf,11,'0') = lpad(v_cpf_pag,11,'0') and m.portador = 166;
              v_ev_origem := 'PRIME_PORTADOR_MEMBRO';
              v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';
              v_motivo := 'negociacao comprovada: o aluno esta no portador 166 (SANTANDER'
                || ' REATIVA) desde ' || coalesce(to_char(v_ev_em,'DD/MM/YYYY'),'?')
                || '; o numero do acordo ' || v_acordo_do_boleto || ' concorda entre a'
                || ' coluna de titulo e o prefixo do boleto. O acordo ainda nao entrou no'
                || ' CRM, e nenhum acordo ou parcela foi criado a partir desta evidencia.';
            end if;

          else
            -- AUSENCIA NAO E PROVA NEGATIVA. Nao estar no espelho do 166 nao diz que
            -- nao houve negociacao -- diz que aqui nao temos como afirmar. A confirmacao
            -- ao vivo (caminho B) e quem pode promover este caso; ate la, fica pendente.
            v_status := 'AGUARDANDO_ACORDO';
            v_motivo := 'boleto ' || v_pag.numero_parcela_completo
              || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM'
              || case when v_cpf_pag is null
                      then ' | sem CPF no pagamento: identidade precisa ser resolvida antes'
                      when coalesce(v_estrutura,'') = 'ENCONTRADA'
                      then ' | a API oficial DEVOLVEU estrutura para este acordo: a captura ainda nao existe, e o payload esta em auditoria'
                      when coalesce(v_estrutura,'') = 'ERRO'
                      then ' | a consulta a API oficial falhou -- sera repetida na proxima janela de 24h'
                      when v_estrutura is null
                      then ' | a API oficial ainda nao foi consultada para este caso -- a rodada horaria consulta'
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

  -- `conciliacao_em` SO ANDA QUANDO O ESTADO MUDA.
  --
  -- Antes gravava now() em toda escrita, e a rodada horaria reescreve o mesmo
  -- estado -- entao a coluna deslizava de hora em hora e nao cumpria o proprio
  -- comentario ("Quando a conciliacao foi decidida"). Ninguem a le hoje (nem
  -- tela nem funcao), e o segundo fim disto e dar ao disparador uma ancora
  -- estavel para a janela de segunda chance: sem ela, a janela nunca fecharia.
  update public.pagamentos
     set status_conciliacao = v_status,
         conciliacao_motivo = v_motivo,
         conciliacao_em     = case
           when status_conciliacao is distinct from v_status then now()
           else coalesce(conciliacao_em, now()) end
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
         -- PRECEDENCIA DA EVIDENCIA. A confirmacao ao vivo grava a linha no espelho
         -- ANTES de chamar o motor -- entao, na rodada seguinte, o motor acharia a
         -- linha e rebaixaria a proveniencia de PRIME_API_LIVE para
         -- PRIME_PORTADOR_MEMBRO, perdendo a informacao de que alguem confirmou
         -- pontualmente. LIVE e a origem mais forte e nunca e trocada.
         evidencia_origem = case
           when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE'
             then 'PRIME_API_LIVE'
           else coalesce(excluded.evidencia_origem, fila_pagamento_sem_vinculo.evidencia_origem) end,
         evidencia_em = case
           when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE'
             then fila_pagamento_sem_vinculo.evidencia_em
           else coalesce(excluded.evidencia_em, fila_pagamento_sem_vinculo.evidencia_em) end
   where fila_pagamento_sem_vinculo.decisao is null;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
    'status', v_status, 'motivo', v_motivo,
    'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
    'aplicou', true, 'baixou', false, 'evidencia', v_evid);
end;
$motor$;

revoke all on function public.pagamento_conciliar_um(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4b. IDENTIDADE PURA, SEM DECISAO FINANCEIRA
-- ---------------------------------------------------------------------------
--
-- O liquidador exige `pagamentos.aluno_id`: fechar divida no aluno errado e
-- pior do que nao fechar. Mas quem resolvia identidade ate agora era
-- `conciliacao_confirmar_portador_166`, e ela faz MUITO mais do que isso --
-- grava evidencia do portador 166 e chama o motor. Usa-la so para descobrir de
-- quem e o pagamento afirmaria negociacao comprovada sem ter consultado o 166.
--
-- Entao a identidade ganha superficie propria, e ela e deliberadamente burra:
-- vincula por CPF quando ha exatamente UM aluno, e para por ai. Nao escreve
-- evidencia, nao mexe em `status_conciliacao`, nao chama o motor, nao decide
-- nada sobre dinheiro.
--
-- NOME NAO VINCULA -- regra da casa desde 08/09/2026, depois de 10 baixas
-- erradas por nome. Zero ou dois alunos pelo CPF: nao toca em nada.

create or replace function public.conciliacao_vincular_identidade_por_cpf(
  p_pagamento_id uuid,
  p_cpf          text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_pag record; v_cpf text; v_cpf_aluno text; v_n int := 0; v_aluno uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Resolver identidade e da gestao ou da rotina.' using errcode = '42501';
  end if;

  select p.id, p.aluno_id, p.cpf into v_pag
    from public.pagamentos p where p.id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  v_cpf := nullif(regexp_replace(coalesce(p_cpf, v_pag.cpf, ''), '\D', '', 'g'), '');
  if v_cpf is null or length(v_cpf) <> 11 then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_CPF', 'tem_aluno', v_pag.aluno_id is not null);
  end if;

  -- JA VINCULADO: nao se sobrescreve identidade, e se o CPF diverge daquele
  -- aluno a registration aponta para outra pessoa -- nao se toca em nada.
  if v_pag.aluno_id is not null then
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0')
      into v_cpf_aluno from public.alunos a where a.id = v_pag.aluno_id;

    if nullif(v_cpf_aluno,'00000000000') is not null
       and v_cpf_aluno <> lpad(v_cpf,11,'0') then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values (coalesce(nullif(auth.email(),''),'rotina'), 'CPF_DIVERGE_DO_ALUNO_VINCULADO',
              'pagamentos', p_pagamento_id::text,
              jsonb_build_object('pagamento_id', p_pagamento_id, 'aluno_id', v_pag.aluno_id,
                                 'cpf_do_aluno', v_cpf_aluno, 'cpf_recebido', lpad(v_cpf,11,'0'),
                                 'origem', 'IDENTIDADE_PURA'));
      return jsonb_build_object('ok', false, 'motivo', 'CPF_DIVERGE_DO_ALUNO_VINCULADO',
        'tem_aluno', true, 'aluno_id', v_pag.aluno_id, 'vinculou', false);
    end if;

    -- mesmo CPF: preserva origem_vinculo, so completa o que faltava
    update public.pagamentos set cpf = coalesce(cpf, v_cpf) where id = p_pagamento_id;
    return jsonb_build_object('ok', true, 'motivo', 'JA_VINCULADO',
      'tem_aluno', true, 'aluno_id', v_pag.aluno_id, 'vinculou', false);
  end if;

  select count(*), min(a.id::text)::uuid into v_n, v_aluno
    from public.alunos a
   where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0');

  if v_n <> 1 then
    -- Zero: o aluno nao existe aqui. Dois: nao da para escolher, e escolher
    -- errado e baixar divida de outra pessoa. Nos dois casos, nao toca.
    return jsonb_build_object('ok', false,
      'motivo', case when v_n = 0 then 'CPF_SEM_ALUNO' else 'CPF_AMBIGUO' end,
      'alunos_pelo_cpf', v_n, 'tem_aluno', false, 'vinculou', false);
  end if;

  update public.pagamentos
     set aluno_id = v_aluno,
         cpf = coalesce(cpf, v_cpf),
         origem_vinculo = 'CPF',
         origem_vinculo_ref = lpad(v_cpf, 11, '0'),
         origem_vinculo_em = now()
   where id = p_pagamento_id;

  return jsonb_build_object('ok', true, 'motivo', 'VINCULADO_POR_CPF',
    'tem_aluno', true, 'aluno_id', v_aluno, 'vinculou', true, 'alunos_pelo_cpf', 1);
end;
$fn$;

comment on function public.conciliacao_vincular_identidade_por_cpf(uuid, text) is
  'Superficie PURA de identidade: vincula o pagamento ao aluno por CPF quando ha exatamente um, e nada mais. Nao grava evidencia de portador, nao altera status_conciliacao, nao chama o motor e nunca vincula por nome. Existe para que o liquidador possa exigir aluno_id sem que descobrir a identidade afirme negociacao comprovada.';

revoke all on function public.conciliacao_vincular_identidade_por_cpf(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. O MOTOR DA LIQUIDACAO
-- ---------------------------------------------------------------------------
--
-- Recebe da Edge as linhas do portador 195 que a Prime devolveu para a
-- registration do pagamento, e conclui os titulos que passarem em TODAS as
-- travas. Nao fala com a Prime -- quem fala e a Edge, que tem a chave.
--
-- AS TRAVAS, E POR QUE CADA UMA EXISTE:
--
--   portador 195          -- so o que e nosso por bordero. 95 e mensalidade
--                            corrente da ULBRA, 166 e convenio de acordo:
--                            nenhum dos dois e titulo que o CRM cobra.
--   liquidacao validada   -- `paymentDate` sozinho nao serve: ele aparece em
--                            titulo ABERTO como placeholder. A regra da casa,
--                            validada em 1.747 pagamentos com zero erro, exige
--                            pago DEPOIS de vencimento+30 E NAO ANTES da
--                            importacao do titulo. As duas metades, com os
--                            operadores exatos que a casa ja usa em
--                            `carteira_2026_1_efetividade` e em
--                            `acoes_massivas_exclui_liquidados_no_prime`:
--                            `liq > vencimento + 30 and liq >= entrada_em`.
--                            O segundo e `>=`, nao `>`: titulo importado e
--                            liquidado no mesmo dia e liquidacao valida.
--   titulo do MESMO aluno -- a ponte e por numero de documento, e numero se
--                            repete entre bases. Sem esta trava, um documento
--                            homonimo fecharia divida de outra pessoa.
--   ABERTO/em_aberto      -- nao se mexe em quitada, cancelada nem duplicada.
--   acordo_id IS NULL     -- titulo ja negociado no CRM tem dono: o acordo
--     e sem vinculo ativo    decide por ele, via titulo_reavaliar.
--   origem_liquidacao     -- idempotencia. Preenchido, ja foi: nao reprocessa
--     ainda vazia            e nao reescreve o motivo.
--
-- E NAO LE DINHEIRO DO PRIME. `paidAmount` la e divida corrigida (R$ 1.110,12
-- num titulo de R$ 543,39) -- usar como caixa seria inventar receita. O caixa
-- e o do Santander, em `pagamentos`, e esta funcao nao encosta nele.

create or replace function public.conciliacao_liquidar_titulo_por_prime(
  p_pagamento_id uuid,
  p_titulos      jsonb,
  p_aplicar      boolean default true
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_pag record; v_t record; v_item jsonb;
  v_boleto text; v_pago date;
  v_liquidados jsonb := '[]'::jsonb; v_recusados jsonb := '[]'::jsonb;
  v_n int := 0; v_soma numeric := 0; v_motivo text;
  -- o que a ESCRITA fez -- nunca o que a leitura previu
  v_rows int := 0; v_escrito numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Liquidar titulo pela Prime e da gestao ou da rotina.' using errcode = '42501';
  end if;

  select p.id, p.aluno_id, p.status_conciliacao, p.titulo_numero, p.data_pagamento
    into v_pag
    from public.pagamentos p where p.id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  -- Ja resolvido: idempotente, e sem reescrever nada.
  if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'ja_resolvido', true, 'liquidados', 0);
  end if;

  -- IDENTIDADE PRIMEIRO. Sem aluno resolvido nao ha a quem pertencer o titulo,
  -- e fechar divida no aluno errado e pior do que nao fechar.
  if v_pag.aluno_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ALUNO_VINCULADO',
      'detalhe', 'a identidade precisa ser resolvida antes de concluir titulo');
  end if;

  -- So age sobre pendencia de acordo. Pagamento ja baixado, em revisao ou sem
  -- vinculo tem outro caminho, e nao e este.
  if coalesce(v_pag.status_conciliacao,'') not in ('AGUARDANDO_ACORDO','ACORDO_CONFIRMADO_SEM_ESTRUTURA') then
    return jsonb_build_object('ok', false, 'motivo', 'ESTADO_NAO_ELEGIVEL',
      'status_conciliacao', v_pag.status_conciliacao);
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_titulos,'[]'::jsonb))
  loop
    v_boleto := nullif(ltrim(regexp_replace(coalesce(v_item->>'boleto',''), '\D', '', 'g'), '0'), '');
    begin
      v_pago := (v_item->>'pago_em')::date;
    exception when others then
      v_pago := null;
    end;

    if coalesce((v_item->>'portador')::int, 0) <> 195 then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'PORTADOR_NAO_E_195');
      continue;
    end if;
    if v_boleto is null or v_pago is null then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'SEM_BOLETO_OU_SEM_DATA');
      continue;
    end if;

    select t.id, t.documento, t.vencimento, t.created_at, t.situacao, t.status,
           t.acordo_id, t.origem_liquidacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as saldo
      into v_t
      from public.acordos_titulos t
     where nullif(ltrim(regexp_replace(coalesce(t.documento,''), '\D', '', 'g'), '0'), '') = v_boleto
       and t.aluno_id = v_pag.aluno_id;

    if not found then
      -- Pode ser titulo que nunca veio por bordero. NAO se cria titulo aqui:
      -- o CRM cobra o que recebeu, e inventar linha inflaria a carteira.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_EXISTE_NO_CRM_PARA_ESTE_ALUNO');
      continue;
    end if;
    if coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_LIQUIDADO');
      continue;
    end if;
    if coalesce(v_t.situacao,'') <> 'ABERTO' or coalesce(v_t.status,'') <> 'em_aberto' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_ESTA_ABERTO',
                                     'situacao', v_t.situacao, 'status', v_t.status);
      continue;
    end if;
    if v_t.acordo_id is not null
       or exists (select 1 from public.acordo_titulo_vinculo v
                   where v.titulo_id = v_t.id and coalesce(v.ativo, true)) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_NEGOCIADO_NO_CRM');
      continue;
    end if;
    if not (v_pago > v_t.vencimento + 30) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_DENTRO_DE_30_DIAS_DO_VENCIMENTO');
      continue;
    end if;
    if not (v_pago >= v_t.created_at::date) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_ANTERIOR_A_IMPORTACAO');
      continue;
    end if;

    if not p_aplicar then
      -- PREVIA: nada e escrito, entao o que se reporta e o que PASSARIA nas
      -- travas agora. Nao promete a corrida -- so a leitura.
      v_n := v_n + 1;
      v_soma := v_soma + v_t.saldo;
      v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                        'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_t.saldo);
      continue;
    end if;

    -- AQUISICAO ATOMICA. As checagens acima foram feitas com a foto de antes;
    -- entre elas e esta escrita outra execucao pode ter levado o mesmo titulo.
    -- Entao a elegibilidade INTEIRA vai no WHERE do proprio UPDATE: em READ
    -- COMMITTED, duas transacoes que disputam a linha serializam, e a segunda
    -- reavalia o predicado contra a linha ja escrita -- encontra
    -- `origem_liquidacao` preenchida e afeta zero linhas. Compare-and-swap,
    -- sem lock explicito.
    --
    -- E o que conta e o que a ESCRITA fez, nao o que a leitura previu: `v_n`,
    -- `v_soma` e o estado do pagamento so avancam com linha realmente alterada.
    update public.acordos_titulos t
       set situacao = 'PAGO',
           status   = 'quitada',
           -- acordo_id continua NULL de proposito: nao ha acordo no CRM, e
           -- criar um so para ter onde apontar seria inventar estrutura.
           origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
           origem_liquidacao_ref = p_pagamento_id::text,
           origem_liquidacao_em  = now(),
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'liquidada na origem: a Prime registra o documento ' || v_boleto
             || ' pago em ' || to_char(v_pago,'DD/MM/YYYY') || ' no portador 195'
             || ', e o Santander pagou o acordo ' || coalesce(nullif(v_pag.titulo_numero,''),'(sem numero)')
             || ' em ' || coalesce(to_char(v_pag.data_pagamento,'DD/MM/YYYY'),'?')
             || '. Nenhum acordo ou parcela foi criado a partir disso.',
           atualizado_em = now()
     where t.id = v_t.id
       and t.aluno_id = v_pag.aluno_id
       and t.origem_liquidacao is null
       and coalesce(t.situacao,'') = 'ABERTO'
       and coalesce(t.status,'')   = 'em_aberto'
       and t.acordo_id is null
       and not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo, true))
    returning coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
      into v_escrito;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      -- Perdeu a corrida, ou a linha deixou de ser elegivel entre a leitura e a
      -- escrita. Nao e erro: e o caso em que NAO se conta.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PERDEU_A_CORRIDA');
      continue;
    end if;

    v_n := v_n + 1;
    v_soma := v_soma + coalesce(v_escrito, 0);
    v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                      'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_escrito);
  end loop;

  if v_n = 0 then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', false,
      'liquidados', 0, 'recusados', v_recusados,
      'motivo', 'nenhum titulo passou nas travas -- o pagamento segue como estava');
  end if;

  v_motivo := 'titulo original concluido pela liquidacao oficial na Prime: ' || v_n
    || ' documento(s) do portador 195 fecharam, somando R$ '
    || to_char(v_soma, 'FM999G999G990D00')
    || ' que saem do saldo em aberto. Nenhum acordo ou parcela foi criado, e nenhuma'
    || ' parcela foi baixada -- o caixa continua sendo o do pagamento Santander.';

  if p_aplicar then
    update public.pagamentos
       set status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           conciliacao_motivo = v_motivo,
           conciliacao_em     = now()
     where id = p_pagamento_id;

    -- `decisao` tem CHECK proprio e nao aceita estado novo: o vocabulario dela
    -- e VINCULADO/DESCARTADO/AGUARDANDO_TERCEIRO/RESOLVIDO_AUTOMATICO/
    -- ENCERRADO_GESTAO. O desfecho especifico mora em `status_conciliacao`,
    -- exatamente como o motor ja faz com BAIXADO.
    update public.fila_pagamento_sem_vinculo
       set decisao = 'RESOLVIDO_AUTOMATICO',
           decidido_por = 'conciliacao@sistema',
           decidido_em = now(),
           status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           observacao = coalesce(observacao,'')
             || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'titulo original concluido pela liquidacao oficial na Prime'
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', p_aplicar,
    'status', 'TITULO_ORIGINAL_LIQUIDADO', 'liquidados', v_n,
    'saldo_que_sai', v_soma, 'titulos', v_liquidados, 'recusados', v_recusados,
    'motivo', v_motivo);
end;
$fn$;

comment on function public.conciliacao_liquidar_titulo_por_prime(uuid, jsonb, boolean) is
  'Conclui o TITULO ORIGINAL quando a Prime registra o documento liquidado no portador 195. Nao cria acordo, nao cria parcela, nao baixa parcela e nao le valor do Prime. Exige aluno vinculado, titulo do mesmo aluno, ABERTO/em_aberto sem acordo nem vinculo ativo, e liquidacao validada pelas duas metades da regra (pago depois de vencimento+30 e depois da importacao). p_aplicar=false e previa sem DML.';

revoke all on function public.conciliacao_liquidar_titulo_por_prime(uuid, jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. PROVA
-- ---------------------------------------------------------------------------
--
-- Roda dentro do apply_migration: se a estrutura nao ficou como descrito, a
-- aplicacao aborta inteira. O que nao da para provar aqui -- comportamento com
-- dado real -- esta nos testes, com mutacao.

do $prova$
declare v_n int; v_src text;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='acordos_titulos'
     and column_name in ('origem_liquidacao','origem_liquidacao_ref','origem_liquidacao_em');
  if v_n <> 3 then raise exception 'as tres marcas da liquidacao nao ficaram'; end if;

  if not exists (select 1 from pg_constraint where conname='acordos_titulos_origem_liquidacao_valida') then
    raise exception 'o CHECK de origem_liquidacao nao entrou';
  end if;

  -- a trava tem de existir E estar armada na tabela
  if not exists (select 1 from pg_trigger
                  where tgname='trg_titulo_liquidado_na_origem_e_terminal'
                    and tgrelid='public.acordos_titulos'::regclass
                    and not tgisinternal) then
    raise exception 'a trava do titulo liquidado nao esta armada em acordos_titulos';
  end if;

  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='titulo_liquidado_na_origem_e_terminal';
  if v_src not ilike '%new.situacao := ''PAGO''%' or v_src not ilike '%new.status   := ''quitada''%' then
    raise exception 'a trava nao coage de volta para PAGO/quitada';
  end if;
  if v_src ilike '%raise exception%' then
    raise exception 'a trava levanta excecao: derrubaria a importacao de acordos inteira';
  end if;

  -- o estado novo do pagamento
  if not exists (select 1 from pg_constraint c
                  where c.conrelid='public.pagamentos'::regclass
                    and pg_get_constraintdef(c.oid) ilike '%TITULO_ORIGINAL_LIQUIDADO%') then
    raise exception 'o CHECK de status_conciliacao nao aceita o estado novo';
  end if;

  -- o motor para nele
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pagamento_conciliar_um';
  if v_src not ilike '%= ''TITULO_ORIGINAL_LIQUIDADO'' then%' then
    raise exception 'o motor nao trata o estado terminal';
  end if;

  -- e o liquidador nao inventa estrutura nem le dinheiro do Prime
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='conciliacao_liquidar_titulo_por_prime';
  if v_src is null then raise exception 'o liquidador nao existe'; end if;
  if v_src ilike '%insert into public.acordos%'
     or v_src ilike '%insert into public.parcelas%' then
    raise exception 'o liquidador cria acordo ou parcela -- nao pode';
  end if;
  if v_src ilike '%paidAmount%' or v_src ilike '%valor_pago%' then
    raise exception 'o liquidador le dinheiro -- o caixa e do Santander';
  end if;
  if v_src not ilike '%t.aluno_id = v_pag.aluno_id%' then
    raise exception 'o liquidador nao exige que o titulo seja do mesmo aluno';
  end if;

  -- a aquisicao tem de ser atomica: elegibilidade no WHERE da escrita, e
  -- contagem pelo que a escrita fez
  if v_src not ilike '%and t.origem_liquidacao is null%' then
    raise exception 'o UPDATE nao confirma a elegibilidade no momento da escrita';
  end if;
  if v_src not ilike '%get diagnostics v_rows = row_count%' then
    raise exception 'o liquidador nao mede o que a escrita realmente alterou';
  end if;
  if v_src not ilike '%if v_rows = 0 then%' then
    raise exception 'o liquidador nao trata a linha que nao foi alterada';
  end if;

  -- e a superficie de identidade tem de ser PURA
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='conciliacao_vincular_identidade_por_cpf';
  if v_src is null then raise exception 'a superficie pura de identidade nao existe'; end if;
  if v_src ilike '%evidencia_origem%' or v_src ilike '%evidencia_em%'
     or v_src ilike '%prime_portador_membro%' then
    raise exception 'a identidade pura grava evidencia do portador -- nao pode';
  end if;
  if v_src ilike '%pagamento_conciliar_um%' or v_src ilike '%status_conciliacao%' then
    raise exception 'a identidade pura decide conciliacao -- nao pode';
  end if;
  if v_src not ilike '%if v_n <> 1 then%' then
    raise exception 'a identidade pura nao exige aluno unico pelo CPF';
  end if;

  -- a janela de segunda chance existe, fecha sozinha, e nao alcanca o historico
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='conciliacao_consultar_portador_pendentes';
  if v_src not ilike '%ACORDO_CONFIRMADO_SEM_ESTRUTURA%' then
    raise exception 'o disparador nao da segunda chance ao estado confirmado';
  end if;
  if v_src not ilike '%conciliacao_em > now() - interval ''72 hours''%' then
    raise exception 'a segunda chance nao tem janela que feche sozinha';
  end if;
  if v_src ilike '%TITULO_ORIGINAL_LIQUIDADO%' then
    raise exception 'o disparador reconsulta quem ja esta liquidado -- nao pode';
  end if;
  if v_src not ilike '%p.status_conciliacao = ''AGUARDANDO_ACORDO''%' then
    raise exception 'o disparador deixou de consultar a pendencia normal';
  end if;

  -- e a ancora da janela precisa ser estavel, senao ela nunca fecha
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pagamento_conciliar_um';
  if v_src not ilike '%status_conciliacao is distinct from v_status then now()%' then
    raise exception 'conciliacao_em volta a deslizar: a janela nunca fecharia';
  end if;

  -- e a proveniencia, uma vez gravada, nao troca de dono
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='titulo_liquidado_na_origem_e_terminal';
  if v_src not ilike '%coalesce(old.origem_liquidacao_ref, new.origem_liquidacao_ref)%' then
    raise exception 'a proveniencia pode ser substituida por outra execucao';
  end if;
end $prova$;


-- ---------------------------------------------------------------------------
-- 7. A SEGUNDA CHANCE DO `ACORDO_CONFIRMADO_SEM_ESTRUTURA`
-- ---------------------------------------------------------------------------
--
-- O PROBLEMA: `ACORDO_CONFIRMADO_SEM_ESTRUTURA` e terminal no motor -- de
-- proposito, para que o espelho do portador, que expira por ciclo, nao
-- transforme a confirmacao de hoje em pendencia no sabado que vem. Mas terminal
-- tambem significa que, se a Prime passar a mostrar o titulo-mae liquidado
-- depois, esse caso nunca mais seria reavaliado. Ficaria congelado numa
-- conclusao verdadeira, porem menos especifica do que a disponivel.
--
-- POR QUE NAO DEU PARA USAR SO O QUE JA EXISTIA -- e foi conferido antes:
--   * `fila.evidencia_em` e `max(prime_portador_membro.coletado_em)`: e quando o
--     ESPELHO foi coletado, nao quando se confirmou. E a varredura semanal
--     re-carimba, entao ele ANDA sozinho -- uma janela ancorada nele reabriria
--     todo sabado, que e exatamente o retry infinito que nao se quer;
--   * `pagamentos.conciliacao_em` gravava now() em toda escrita, e a rodada
--     horaria reescreve o mesmo estado: deslizava de hora em hora.
--
-- O LIMITE E O RELOGIO, NAO UMA CONTAGEM. A garantia do codigo e "janela de
-- 72h + no maximo uma tentativa por 24h" -- nao "exatamente duas reconsultas".
-- As duas sao o que o fluxo automatico normal produz; um caminho excepcional
-- com `consulta_portador_em` nula ou antiga cabe uma tentativa a mais. Isso e
-- aceito de proposito: contar tentativas exigiria coluna nova, e a janela ja
-- garante que acaba.
--
-- A CORRECAO E NO SEGUNDO, e ela cabe no contrato que ele ja declara
-- ("Quando a conciliacao foi decidida"). Ninguem le essa coluna hoje -- nem
-- tela, nem funcao -- entao faze-la parar de deslizar nao quebra leitor nenhum,
-- e passa a valer o que o nome diz. A alteracao esta na secao 4, no motor.
--
-- NENHUMA COLUNA NOVA, nenhum cron novo, nenhuma frequencia aumentada.
--
-- ERRO TECNICO CONSOME UMA DAS DUAS CHANCES, e isto e deliberado. A alternativa
-- seria nao carimbar `consulta_portador_em` quando a chamada falha -- que e
-- exatamente o buraco que o #379 fechou de proposito (o caso voltaria de hora
-- em hora, para sempre). O custo de consumir uma chance e pequeno e nao
-- destroi nada: o caso permanece em `ACORDO_CONFIRMADO_SEM_ESTRUTURA`, que
-- continua sendo verdade, e que e o mesmo destino previsto para quem esgota a
-- janela sem liquidacao.

create or replace function public.conciliacao_consultar_portador_pendentes(
  p_limite int default 5
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_url text; v_token text; v_req bigint; v_carga jsonb;
  v_n int := 0; v_casos jsonb := '[]'::jsonb; r record;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Consulta pontual ao portador e da gestao ou da rotina.' using errcode = '42501';
  end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    return jsonb_build_object('pulou', 'sistema sob carga');
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    return jsonb_build_object('pulou', 'segredo ausente no Vault');
  end if;

  for r in
    select p.id,
           coalesce(nullif(p.matricula,''), f.matricula_recebida) as registration,
           p.titulo_numero
      from public.pagamentos p
      join public.fila_pagamento_sem_vinculo f
        on f.pagamento_id = p.id and f.decisao is null
     where (
             -- a pendencia de sempre
             (p.status_conciliacao = 'AGUARDANDO_ACORDO' and f.evidencia_origem is null)
             -- SEGUNDA CHANCE, CURTA E QUE FECHA SOZINHA.
             --
             -- `ACORDO_CONFIRMADO_SEM_ESTRUTURA` afirma que houve negociacao --
             -- e isso continua verdade. Mas o extrato da Prime pode passar a
             -- mostrar o titulo-mae liquidado depois, e ai existe resposta
             -- melhor. Sem esta janela o caso ficaria congelado para sempre.
             --
             -- O QUE O CODIGO GARANTE, e so isso: janela FINITA de 72h a
             -- partir de `conciliacao_em`, que agora so anda quando o ESTADO
             -- muda, mais no maximo UMA tentativa por 24h por caso. Em +72h a
             -- janela fecha e o caso para de ser consultado, para sempre.
             --
             -- No fluxo automatico normal isso produz DUAS reconsultas (~+24h e
             -- ~+48h), porque a confirmacao vem logo depois de um disparo e
             -- `consulta_portador_em` esta fresca. Mas nao e invariante: num
             -- caminho excepcional -- `consulta_portador_em` nula ou antiga,
             -- por confirmacao vinda da rodada em lote e nao do disparador --
             -- cabe uma tentativa adicional imediata. O limite continua sendo o
             -- relogio, nao uma contagem, e de proposito: contar exigiria
             -- coluna nova para um ganho que a janela ja entrega.
             --
             -- Nao exige `evidencia_origem is null` aqui: um caso confirmado TEM
             -- evidencia -- e essa e justamente a condicao que o traz de volta.
             or (p.status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'
                 and p.conciliacao_em > now() - interval '72 hours')
           )
       -- NAO exclui quem ja tem linha local do 166. O espelho prova negociacao,
       -- nao ausencia de estrutura -- e a tentativa oficial precisa acontecer
       -- antes do fallback. O teto de uma por dia por caso e que segura o volume.
       and coalesce(nullif(p.matricula,''), f.matricula_recebida) ~ '^\d{6,12}$'
       and (f.consulta_portador_em is null
            or f.consulta_portador_em < now() - interval '24 hours')
     order by p.data_pagamento, p.id
     limit greatest(coalesce(p_limite, 5), 0)
  loop
    -- A marca vem ANTES: se a chamada falhar, o caso nao volta na proxima hora.
    -- E SO ISSO que ela significa -- frequencia, uma tentativa por dia por caso.
    -- Nao e resultado: quem responde "o que a API disse" e
    -- `consulta_estrutura_resultado`, gravado pela Edge DEPOIS da chamada.
    update public.fila_pagamento_sem_vinculo
       set consulta_portador_em = now()
     where pagamento_id = r.id;

    select net.http_post(
      url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
      headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
      body := jsonb_build_object('registration', r.registration, 'pagamento_id', r.id,
                                 'titulo_numero', r.titulo_numero),
      timeout_milliseconds := 60000) into v_req;

    v_n := v_n + 1;
    v_casos := v_casos || jsonb_build_object('pagamento_id', r.id,
                            'registration', r.registration, 'requisicao', v_req);
  end loop;

  return jsonb_build_object('disparados', v_n, 'limite', p_limite, 'casos', v_casos);
end;
$fn$;

comment on function public.conciliacao_consultar_portador_pendentes(int) is
  'Disparador do caminho ao vivo. Consulta AGUARDANDO_ACORDO sem evidencia e, por no maximo 72h a partir de conciliacao_em, tambem ACORDO_CONFIRMADO_SEM_ESTRUTURA. O que o codigo garante na segunda chance e janela finita de 72h mais no maximo uma tentativa por 24h por caso -- no fluxo normal isso da duas reconsultas, mas nao e invariante: com consulta_portador_em nula ou antiga cabe uma tentativa adicional. Depois de 72h a janela fecha sozinha. Usa consulta_portador_em SOMENTE como controle de frequencia. Chamado pela rodada horaria -- nunca pelo gatilho de INSERT.';

revoke all on function public.conciliacao_consultar_portador_pendentes(int) from public, anon, authenticated;
