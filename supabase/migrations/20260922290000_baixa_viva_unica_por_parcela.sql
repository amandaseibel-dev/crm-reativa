-- UMA UNICA BAIXA VIVA POR PARCELA.
--
-- PROBLEMA MEDIDO EM PRODUCAO (22/09/2026, auditoria somente leitura): 11
-- parcelas tem DUAS baixas vivas (devolvido_em nulo) cada uma, com valor e
-- honorarios identicos. R$ 34.138,60 registrados onde sao devidos
-- R$ 17.069,30 -- excedente de R$ 17.069,30. A parcela esta PAGO uma vez so,
-- entao o saldo do aluno nao muda; o que sai errado e o valor baixado do dia
-- e a efetividade/comissao de quem aparece como responsavel.
--
-- NAO E O MOTOR AUTOMATICO: `origem_baixa_ref` repetida em parcelas = 0. Os 11
-- vem do fluxo manual (botao "Confirmar baixa" da ficha), com um caso de
-- colisao entre a baixa manual e a rotina de baixa pelo documento.
--
-- POR QUE A GUARDA QUE JA EXISTE NAO RESOLVE: `baixar_parcela_acordo` recusa
-- parcela com status PAGO desde 20260908150000, e mesmo assim a parcela
-- e62006af-a61e-43eb-9729-367819c06e76 recebeu a segunda baixa viva em
-- 10/09/2026, DEPOIS daquela guarda. O `atualizado_em` da parcela e exatamente
-- o horario dessa segunda baixa: naquele instante a parcela nao estava PAGO.
-- Ou seja, existe caminho que cria baixa viva sem marcar a parcela, e o status
-- da parcela ainda pode ser revertido depois por outra rotina. Medir unicidade
-- pelo STATUS DA PARCELA e frouxo; o certo e medir pela BAIXA VIVA.
--
-- POR QUE GATILHO E NAO INDICE UNICO (as duas razoes):
--   1. os 11 historicos ainda existem, e `CREATE UNIQUE INDEX` falharia. A
--      ordem pedida pela gestao e impedir o 12o caso ANTES de sanear os 11;
--   2. sao 6 caminhos de escrita nesta tabela -- 4 RPCs, a rotina de baixa
--      pelo documento e um INSERT DIRETO do cliente (src/utils/lancarAcordo.js),
--      que a RLS permite (politica baixas_pagamento_insert, WITH CHECK
--      app_usuario_ativo() AND usuario_e_gestao()). Trava so dentro das RPCs
--      seria contornavel pelo caminho direto.
-- O indice unico parcial entra numa etapa separada, depois do saneamento, como
-- garantia estrutural definitiva.
--
-- SERIALIZACAO, E NAO SO `IF EXISTS`: duas transacoes simultaneas na mesma
-- parcela passariam as duas por um `if exists` puro -- nenhuma enxerga a linha
-- ainda nao commitada da outra, e as duas inserem. Por isso a funcao trava a
-- LINHA DA PARCELA com `select ... for update` ANTES de olhar. A segunda
-- transacao fica bloqueada nesse ponto ate a primeira terminar; quando volta,
-- ja enxerga a baixa da outra e recusa. `parcelas` e a escolha natural de
-- ponto de serializacao: e a propria obrigacao, tem chave primaria, e as duas
-- RPCs ja travam essa linha ou o acordo -- nao inventa um recurso novo de
-- bloqueio nem depende de hash de advisory lock.
--
-- O QUE CONTINUA PERMITIDO, DE PROPOSITO:
--   * baixa com parcela_id nulo (fluxo do comprovante, antes da amarracao):
--     377 baixas vivas hoje;
--   * estorno: e UPDATE de devolvido_em, o gatilho nem olha;
--   * NOVA baixa depois de estornada: a devolvida sai da regra -- 37 parcelas
--     ja estao nesse estado hoje e seguem validas;
--   * varias parcelas do mesmo acordo: a chave e por parcela -- 431 acordos;
--   * quitacao de multiplas parcelas: uma baixa por parcela, todas passam.
--
-- NAO CRIA CONCEITO DE BAIXA PARCIAL / COMPLEMENTO: ele nao existe no modelo
-- hoje. `baixar_parcela_acordo` marca a parcela PAGO com qualquer valor, e nas
-- 11 parcelas duplicadas NENHUMA soma menos que a parcela -- todas somam
-- exatamente 2x. Zero casos de "soma menor". Inventar o conceito aqui seria
-- abrir uma porta que a operacao nao usa.
--
-- ESTA MIGRATION NAO TOCA EM DADO: nenhum DELETE, nenhuma devolucao dos 11
-- historicos, nenhum backfill, nenhuma correcao de comissao. So define funcao,
-- gatilho e as duas guardas amigaveis. Os 11 seguem vivos e intocados.

-- ---------------------------------------------------------------------------
-- 1) A trava central. Roda para TODO INSERT, venha de RPC, rotina ou cliente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._baixa_viva_unica_por_parcela()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ja      public.baixas_pagamento%rowtype;
  v_quem    text;
  v_quando  text;
begin
  -- Fluxo do comprovante: a baixa nasce sem parcela amarrada. Sem obrigacao
  -- identificada nao ha o que duplicar.
  if new.parcela_id is null then
    return new;
  end if;

  -- Linha que ja nasce devolvida nao e registro financeiro vivo.
  if new.devolvido_em is not null then
    return new;
  end if;

  -- SERIALIZACAO POR OBRIGACAO, antes de qualquer leitura. Duas transacoes na
  -- mesma parcela se enfileiram aqui; a segunda so continua depois que a
  -- primeira commitou, e ai ja enxerga a baixa dela.
  perform 1 from public.parcelas where id = new.parcela_id for update;

  select * into v_ja
    from public.baixas_pagamento
   where parcela_id = new.parcela_id
     and devolvido_em is null
   order by baixado_em desc nulls last
   limit 1;

  if found then
    v_quem := coalesce(
      nullif(btrim(v_ja.responsavel_baixa_email), ''),
      nullif(btrim(v_ja.baixado_por_email), ''),
      nullif(btrim(v_ja.baixado_por_nome), ''),
      'origem nao registrada');
    v_quando := to_char(
      coalesce(v_ja.baixado_em, v_ja.recebido_em, v_ja.atualizado_em),
      'DD/MM/YYYY HH24:MI');

    raise exception
      'Esta parcela ja tem baixa registrada em % por % (R$ %). Se a baixa anterior estiver errada, estorne ela primeiro e so depois registre a nova -- duas baixas vivas na mesma parcela contam o dinheiro em dobro.',
      coalesce(v_quando, 'data nao registrada'), v_quem,
      -- 'G'/'D' seguem o locale do servidor; ',' e '.' literais nao. Formata em
      -- padrao americano e troca os dois simbolos, pra sair 1.234,56 em qualquer lugar.
      translate(to_char(coalesce(v_ja.valor_pago, 0), 'FM999,999,990.00'), '.,', ',.')
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

comment on function public._baixa_viva_unica_por_parcela() is
  'Gatilho BEFORE INSERT em baixas_pagamento: no maximo uma baixa VIVA (devolvido_em nulo) por parcela_id. Serializa por linha de parcelas (select ... for update) ANTES de checar, senao duas transacoes simultaneas passariam as duas. Nao alcanca baixa com parcela_id nulo, estorno, nova baixa apos estorno, nem parcelas diferentes do mesmo acordo.';

DROP TRIGGER IF EXISTS trg_baixa_viva_unica_por_parcela ON public.baixas_pagamento;
CREATE TRIGGER trg_baixa_viva_unica_por_parcela
  BEFORE INSERT ON public.baixas_pagamento
  FOR EACH ROW EXECUTE FUNCTION public._baixa_viva_unica_por_parcela();

-- ---------------------------------------------------------------------------
-- 2) Guardas amigaveis nas duas RPCs da tela. A seguranca real e o gatilho
--    acima; aqui e so para a operadora ler uma frase util em vez de um erro
--    cru do banco. Fora dos blocos marcados, corpo identico ao de producao --
--    ver supabase/audits/baixa_viva_unica_por_parcela_producao_20260922.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.baixar_parcela_acordo(p_parcela_id uuid, p_data date DEFAULT CURRENT_DATE, p_valor numeric DEFAULT NULL::numeric, p_honorarios numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_agora   timestamptz := now();
  v_data    date := coalesce(p_data, current_date);
  v_parc    public.parcelas%rowtype;
  v_acordo  public.acordos%rowtype;
  v_aluno   public.alunos%rowtype;
  v_baixa   uuid;
  v_ja      public.baixas_pagamento%rowtype;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Baixa de pagamento e exclusiva da gestao financeira.'
      using errcode = '42501';
  end if;

  select * into v_parc from public.parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela nao encontrada.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_parc.status, '')) = 'PAGO' then
    raise exception 'Esta parcela ja esta paga.' using errcode = 'P0001';
  end if;

  -- GUARDA AMIGAVEL (22/09/2026). O `for update` logo acima ja serializou esta
  -- parcela, entao a leitura abaixo e confiavel. Nao substitui a trava do
  -- banco (trg_baixa_viva_unica_por_parcela): existe INSERT direto do cliente
  -- que nao passa por aqui. Serve para a tela mostrar a mensagem certa em vez
  -- de um erro cru.
  --
  -- E NAO E REDUNDANTE COM A GUARDA DE STATUS ACIMA: medido em producao, a
  -- parcela e62006af-a61e-43eb-9729-367819c06e76 recebeu segunda baixa viva
  -- com a parcela ainda NAO PAGO -- ha caminho que grava baixa sem marcar a
  -- parcela, e o status pode ser revertido por outra rotina.
  select * into v_ja
    from public.baixas_pagamento
   where parcela_id = p_parcela_id and devolvido_em is null
   order by baixado_em desc nulls last
   limit 1;
  if found then
    raise exception
      'Esta parcela ja tem baixa registrada em % por %. Estorne a baixa anterior antes de registrar uma nova.',
      coalesce(to_char(coalesce(v_ja.baixado_em, v_ja.recebido_em), 'DD/MM/YYYY HH24:MI'), 'data nao registrada'),
      coalesce(nullif(btrim(v_ja.responsavel_baixa_email), ''),
               nullif(btrim(v_ja.baixado_por_email), ''), 'origem nao registrada')
      using errcode = 'P0001';
  end if;

  select * into v_acordo from public.acordos where id = v_parc.acordo_id;
  if not found then
    raise exception 'Acordo da parcela nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo esta cancelado -- nao e possivel registrar baixa.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) = 'QUITADO' then
    raise exception 'Este acordo ja esta quitado -- nao e possivel registrar baixa.' using errcode = 'P0001';
  end if;

  select * into v_aluno from public.alunos where id = v_acordo.aluno_id;

  update public.parcelas
     set status = 'PAGO',
         pago_em = (v_data::timestamp at time zone 'America/Sao_Paulo'),
         confirmado_por_email = v_email,
         atualizado_em = v_agora
   where id = p_parcela_id;

  insert into public.baixas_pagamento (
    aluno_id, aluno_nome, aluno_cpf, parcela_id, acordo_id,
    valor_pago, honorarios_recebidos, data_pagamento, status_baixa,
    responsavel_baixa_email, baixado_por_email,
    recebido_em, atualizado_em, baixado_em
  ) values (
    v_acordo.aluno_id::text, v_aluno.nome, v_aluno.cpf, p_parcela_id, v_acordo.id,
    coalesce(p_valor, v_parc.valor, 0), p_honorarios, v_data, 'REALIZADA',
    coalesce(v_acordo.operador_responsavel_email, v_acordo.criado_por_email),
    v_email,
    v_agora, v_agora, v_agora
  ) returning id into v_baixa;

  return jsonb_build_object(
    'ok', true,
    'parcela_id', p_parcela_id,
    'baixa_id', v_baixa,
    'acordo_status', (select status from public.acordos where id = v_acordo.id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.quitar_acordo_cartao(p_acordo_id uuid, p_data date DEFAULT CURRENT_DATE, p_comprovante_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_agora   timestamptz := now();
  v_data    date := coalesce(p_data, current_date);
  v_acordo  public.acordos%rowtype;
  v_aluno   public.alunos%rowtype;
  v_qtd     int := 0;
  v_total   numeric := 0;
  v_parcela_ja uuid;
  v_qtd_ja  int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Quitacao/baixa e exclusiva da gestao financeira.'
      using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo esta cancelado -- nao e possivel quitar.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) = 'QUITADO' then
    raise exception 'Este acordo ja esta quitado.' using errcode = 'P0001';
  end if;

  select * into v_aluno from public.alunos where id = v_acordo.aluno_id;

  -- GUARDA AMIGAVEL (22/09/2026), TUDO OU NADA. Trava as parcelas-alvo e
  -- recusa a operacao INTEIRA se qualquer uma ja tiver baixa viva -- nao quita
  -- "as outras" deixando um rastro parcial. O `for update` serializa antes de
  -- olhar; sem ele, duas quitacoes simultaneas passariam as duas.
  -- A trava real continua sendo trg_baixa_viva_unica_por_parcela.
  perform 1
    from public.parcelas p
   where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO')
   order by p.id
   for update;

  select p.id, count(*) over () into v_parcela_ja, v_qtd_ja
    from public.parcelas p
    join public.baixas_pagamento b
      on b.parcela_id = p.id and b.devolvido_em is null
   where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO')
   limit 1;
  if v_parcela_ja is not null then
    raise exception
      'Nao da para quitar: % parcela(s) deste acordo ja tem baixa registrada. Estorne a baixa anterior antes de quitar -- a operacao foi recusada inteira, nenhuma parcela foi baixada.',
      v_qtd_ja using errcode = 'P0001';
  end if;

  insert into public.baixas_pagamento (
    aluno_id, aluno_nome, aluno_cpf, parcela_id, acordo_id,
    valor_pago, honorarios_recebidos, data_pagamento, comprovante_url, status_baixa,
    responsavel_baixa_email, baixado_por_email,
    recebido_em, atualizado_em, baixado_em
  )
  select
    v_acordo.aluno_id::text, v_aluno.nome, v_aluno.cpf, p.id, v_acordo.id,
    coalesce(p.valor, 0), p.honorarios, v_data, nullif(btrim(p_comprovante_url), ''), 'REALIZADA',
    coalesce(v_acordo.operador_responsavel_email, v_acordo.criado_por_email),
    v_email,
    v_agora, v_agora, v_agora
  from public.parcelas p
  where p.acordo_id = p_acordo_id
    and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO');

  update public.parcelas p
     set status = 'PAGO',
         pago_em = (v_data::timestamp at time zone 'America/Sao_Paulo'),
         confirmado_por_email = v_email,
         atualizado_em = v_agora
   where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO');
  get diagnostics v_qtd = row_count;

  if v_qtd = 0 then
    raise exception 'Este acordo nao tem parcelas em aberto para quitar.' using errcode = 'P0001';
  end if;

  select coalesce(sum(valor_pago), 0) into v_total
    from public.baixas_pagamento
   where acordo_id = p_acordo_id and baixado_em = v_agora and baixado_por_email = v_email;

  return jsonb_build_object(
    'ok', true,
    'parcelas_quitadas', v_qtd,
    'valor_total', v_total,
    'acordo_status', (select status from public.acordos where id = p_acordo_id)
  );
end;
$function$;
