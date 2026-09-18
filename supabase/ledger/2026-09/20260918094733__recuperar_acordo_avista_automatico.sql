-- RECUPERACAO AUTOMATICA DO ACORDO A VISTA PAGO ANTES DA IMPORTACAO
-- 17/09/2026
--
-- O caso: o aluno pagou um acordo a vista, o acordo quitou na origem e nunca
-- veio no relatorio de titulos em aberto. O pagamento fica em "Pagamentos a
-- conciliar" como AGUARDANDO_ACORDO porque nao existe parcela com aquele
-- boleto -- nem acordo com aquele numero.
--
-- O que esta entrega faz: liga o que ja existe. A previa `acordo_avista_previa`
-- (a MESMA do botao "Registrar acordo a vista", intocada aqui) continua sendo a
-- unica fonte de verdade das 21 protecoes; o registrador `acordo_avista_registrar`
-- continua sendo o unico que escreve. Esta migration so:
--   1. cria o par automatico (um pagamento / o lote pendente);
--   2. abre no registrador uma porta de maquina, fechada para a tela;
--   3. pendura a etapa na rodada horaria e na importacao de pagamentos;
--   4. cria a chave de configuracao -- DESLIGADA.
--
-- Nao altera: a previa, o motor de baixa, a reconstrucao da parcela paga antes
-- da extracao, o encerramento da pendencia, a reposicao de carteira.
--
-- Recusa nao decide nada: o pagamento continua na fila com o motivo especifico
-- e volta a ser avaliado na proxima rodada -- se o acordo chegar depois, o
-- motor normal baixa e a etapa nem chega a olhar.

-- ---------------------------------------------------------------------------
-- 0. A PORTA DE MAQUINA
--
-- Duas condicoes, e as duas so existem dentro da rotina automatica:
--   1. a chave transacional, que so `acordo_avista_recuperar_um` acende e que
--      morre com a transacao;
--   2. a pilha de chamada do PL/pgSQL, que nao se forja: `authenticated` nao
--      tem CREATE em schema nenhum, entao nao ha como criar uma funcao com
--      esse nome para aparecer na pilha.
-- Sozinha, a chave seria uma variavel de sessao como outra qualquer. Com a
-- pilha, quem chamar os registradores por fora continua barrado mesmo tendo
-- acendido a chave.
-- ---------------------------------------------------------------------------
create or replace function public.acordo_avista_porta_interna()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare v_ctx text;
begin
  if coalesce(current_setting('reativa.recuperacao_avista', true), 'off') <> 'on' then
    return false;
  end if;
  get diagnostics v_ctx = pg_context;
  return position('function acordo_avista_recuperar_um(uuid,boolean)' in v_ctx) > 0;
end;
$fn$;

comment on function public.acordo_avista_porta_interna() is
  'Verdadeiro so dentro da execucao de acordo_avista_recuperar_um: exige a chave transacional reativa.recuperacao_avista E a presenca da rotina na pilha de chamada do PL/pgSQL. Nao ha como produzir as duas condicoes de fora.';

-- ---------------------------------------------------------------------------
-- 1. Um pagamento: previa -> mensalidades sugeridas -> registrador -> motor
-- ---------------------------------------------------------------------------
create or replace function public.acordo_avista_recuperar_um(
  p_pagamento_id uuid, p_aplicar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_previa jsonb; v_ids uuid[]; v_cod text; v_desc text; v_prefixo text; v_out jsonb;
begin
  -- A PREVIA DO BOTAO E A FONTE DE VERDADE. Nenhuma regra nova aqui: esta
  -- funcao escolhe as mensalidades que a propria previa sugeriu (as elegiveis
  -- do aluno) e entrega ao registrador que a gestao ja usa.
  v_previa := public.acordo_avista_previa(p_pagamento_id, null);

  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    v_cod := coalesce(v_previa -> 'bloqueios' ->> 0, 'SEM_BLOQUEIO_NOMEADO');
    v_desc := case v_cod
      when 'PAGAMENTO_EXISTE' then 'pagamento nao encontrado'
      when 'ESTADO_AGUARDANDO_ACORDO' then 'o pagamento nao esta aguardando acordo'
      when 'FILA_SEM_DECISAO' then 'a pendencia ja foi decidida'
      when 'PAGAMENTO_NAO_ESTORNADO_NEM_RETROATIVO' then 'pagamento estornado ou retroativo'
      when 'BOLETO_NO_PADRAO' then 'o boleto nao e 5 + acordo + parcela'
      when 'BOLETO_PARCELA_0001' then 'o boleto nao e da parcela 0001: o acordo nao e a vista'
      when 'UNICO_BOLETO_DO_ACORDO' then 'o acordo tem outros boletos: nao e pagamento unico'
      when 'NUMERO_ULBRA_INEXISTENTE' then 'o acordo ja existe no CRM'
      when 'AUSENCIA_EXPLICADA' then 'acordo de numero maior ja tinha sido importado: ausencia nao explicada'
      when 'MATRICULA_APONTA_UM_ALUNO' then 'a matricula nao aponta um aluno unico'
      when 'NOME_APONTA_UM_ALUNO' then 'o nome do arquivo nao aponta um aluno unico'
      when 'MATRICULA_E_NOME_MESMO_ALUNO' then 'matricula e nome apontam alunos diferentes'
      when 'ALUNO_NAO_ENCERRADO' then 'o aluno esta encerrado: decisao da gestao'
      when 'VENCIMENTO_NO_ARQUIVO' then 'o arquivo nao trouxe o vencimento'
      when 'VALOR_COMPATIVEL_COM_A_BAIXA' then 'o valor pago nao cabe na faixa que o motor aceita'
      when 'OPERADOR_CADASTRADO' then 'o operador do pagamento nao esta cadastrado'
      when 'TITULOS_ESCOLHIDOS' then 'nenhuma mensalidade elegivel para formar o acordo'
      when 'TITULOS_ELEGIVEIS' then 'ha mensalidade nao elegivel entre as sugeridas'
      when 'SOMA_ATE_O_VALOR_PAGO' then 'a soma das mensalidades passa do valor pago'
      when 'DIFERENCA_DENTRO_DA_MARGEM_SEGURA' then 'o valor pago excede a margem de 15% sobre a divida'
      when 'SEM_ACORDO_ATIVO_IDENTICO' then 'ja existe acordo ativo igual para o aluno'
      else 'recusado pela previa do acordo a vista' end;

    -- O MOTIVO EM PAGAMENTOS A CONCILIAR: codigo estavel e descricao curta na
    -- frente do texto do motor, que reescreve `motivo` a cada passada. So o
    -- proprio prefixo e trocado -- e o da reconstrucao, se estiver na frente,
    -- e preservado no lugar dele.
    if coalesce(p_aplicar, false) then
      v_prefixo := 'ACORDO_AVISTA_' || v_cod || ': ' || v_desc || ' | ';
      update public.fila_pagamento_sem_vinculo f
         set motivo = v_prefixo
             || regexp_replace(f.motivo, '^(ACORDO_AVISTA_[A-Z_]+: [^|]* \| )+', '')
       where f.pagamento_id = p_pagamento_id
         and f.decisao is null
         and not starts_with(f.motivo, v_prefixo);
    end if;

    return jsonb_build_object('gravou', false, 'aprovado', false,
      'diagnostico', jsonb_build_object('codigo', 'ACORDO_AVISTA_' || v_cod, 'descricao', v_desc),
      'bloqueios', v_previa -> 'bloqueios');
  end if;

  -- As mensalidades sao as que a previa ja declarou elegiveis. Confirmar sem
  -- lista nao grava nada: o registrador recusa.
  select array_agg((t ->> 'id')::uuid order by t ->> 'vencimento', t ->> 'documento')
    into v_ids
    from jsonb_array_elements(v_previa -> 'titulos' -> 'selecionados') t
   where t ->> 'impedimento' is null;

  if v_ids is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('gravou', false, 'aprovado', true,
      'diagnostico', jsonb_build_object('codigo', 'ACORDO_AVISTA_SEM_MENSALIDADE',
        'descricao', 'a previa aprovou sem mensalidade elegivel'));
  end if;

  if not coalesce(p_aplicar, false) then
    return jsonb_build_object('gravou', false, 'aprovado', true, 'modo', 'SIMULACAO',
      'titulos', to_jsonb(v_ids), 'acordo_a_criar', v_previa -> 'acordo_a_criar',
      'parcela_a_criar', v_previa -> 'parcela_a_criar');
  end if;

  -- A PORTA DA MAQUINA, acesa so aqui e so ate o fim da transacao. O
  -- registrador refaz a previa por dentro, com a lista escolhida, e e ele quem
  -- escreve: acordo, parcela, mensalidades, vinculo do pagamento e baixa.
  perform set_config('reativa.recuperacao_avista', 'on', true);
  begin
    v_out := public.acordo_avista_registrar(p_pagamento_id, v_ids, true);
  exception when others then
    perform set_config('reativa.recuperacao_avista', 'off', true);
    raise;
  end;
  perform set_config('reativa.recuperacao_avista', 'off', true);

  if not coalesce((v_out ->> 'gravou')::boolean, false) then
    return jsonb_build_object('gravou', false, 'aprovado', false,
      'diagnostico', jsonb_build_object('codigo', 'ACORDO_AVISTA_RECUSADO_NA_GRAVACAO',
        'descricao', coalesce(v_out ->> 'motivo', 'a previa recusou na hora de gravar')),
      'bloqueios', coalesce(v_out -> 'bloqueios', '[]'::jsonb));
  end if;

  -- o estado final e o do registrador; aqui so se confere o que interessa a fila
  if coalesce(v_out -> 'estado_depois' -> 'pagamento' ->> 'status_conciliacao', '') <> 'BAIXADO' then
    raise exception 'ACORDO_AVISTA_ABORTADO: o motor nao baixou o pagamento %', p_pagamento_id;
  end if;

  return jsonb_build_object('gravou', true, 'aprovado', true,
    'numero_ulbra', v_out -> 'acordo_a_criar' ->> 'numero_ulbra',
    'acordo_id', v_out -> 'acordo_id', 'parcela_id', v_out -> 'parcela_id',
    'titulos', cardinality(v_ids),
    'estado_depois', v_out -> 'estado_depois');
end;
$fn$;

comment on function public.acordo_avista_recuperar_um(uuid, boolean) is
  'Recuperacao automatica de um acordo a vista pago antes da importacao. A previa acordo_avista_previa decide; o registrador acordo_avista_registrar grava; o motor baixa. Recusa nao decide nada: so grava o motivo especifico na fila.';

-- ---------------------------------------------------------------------------
-- 2. O lote pendente
-- ---------------------------------------------------------------------------
create or replace function public.acordo_avista_recuperar_pendentes(
  p_limite integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid; v_r jsonb; v_cod text;
  v_n int := 0; v_ok int := 0; v_err int := 0;
  v_bloq jsonb := '{}'::jsonb; v_itens jsonb := '[]'::jsonb;
begin
  for v_id in
    select g.id
      from public.pagamentos g
     -- SO O QUE ESTA ETAPA SABE TRATAR: boleto de parcela unica, sem parcela
     -- no CRM e sem acordo com aquele numero. Quem ja tem acordo e da
     -- reconstrucao da parcela paga antes da extracao -- as duas selecoes sao
     -- excludentes por construcao.
     where g.status_conciliacao = 'AGUARDANDO_ACORDO'
       and ltrim(coalesce(g.numero_parcela_completo, ''), '0') ~ '^5\d{6}0001$'
       and not exists (select 1 from public.parcelas q
                        where q.boleto = ltrim(g.numero_parcela_completo, '0'))
       and not exists (select 1 from public.acordos a
                        where a.numero_ulbra is not null
                          and lpad(a.numero_ulbra, 6, '0') = substr(ltrim(g.numero_parcela_completo, '0'), 2, 6))
       -- o que a gestao ja decidiu nao volta sozinho
       and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                        where f.pagamento_id = g.id and f.decisao is not null)
     -- o mais novo primeiro: recusa antiga parada nao segura o que acabou de chegar
     order by g.data_pagamento desc, g.id
     limit greatest(coalesce(p_limite, 25), 0)
  loop
    v_n := v_n + 1;
    begin
      v_r := public.acordo_avista_recuperar_um(v_id, true);
      if coalesce((v_r ->> 'gravou')::boolean, false) then
        v_ok := v_ok + 1;
      else
        v_cod := coalesce(v_r -> 'diagnostico' ->> 'codigo', 'ACORDO_AVISTA_SEM_DIAGNOSTICO');
        v_bloq := jsonb_set(v_bloq, array[v_cod], to_jsonb(coalesce((v_bloq ->> v_cod)::int, 0) + 1), true);
      end if;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object(
        'pagamento_id', v_id, 'numero_ulbra', v_r ->> 'numero_ulbra',
        'gravou', coalesce((v_r ->> 'gravou')::boolean, false),
        'diagnostico', v_r -> 'diagnostico' ->> 'codigo'));
    exception when others then
      -- um pagamento nao derruba os outros; o erro fica registrado
      v_err := v_err + 1;
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('conciliacao@sistema', 'RECUPERACAO_AVISTA_FALHOU', 'pagamentos', v_id,
              jsonb_build_object('erro', SQLERRM));
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('pagamento_id', v_id, 'erro', SQLERRM));
    end;
  end loop;

  return jsonb_build_object('avaliados', v_n, 'recuperados', v_ok, 'erros', v_err,
                            'recusados_por_motivo', v_bloq, 'itens', v_itens);
end;
$fn$;

comment on function public.acordo_avista_recuperar_pendentes(integer) is
  'Roda a recuperacao do acordo a vista nos pagamentos AGUARDANDO_ACORDO com boleto de parcela unica e sem acordo no CRM. Falha de um pagamento nao derruba os outros nem a importacao.';

-- ---------------------------------------------------------------------------
-- 3. O registrador da gestao ganha a porta de maquina (nada mais muda)
-- ---------------------------------------------------------------------------
create or replace function public.acordo_avista_registrar(
  p_pagamento_id uuid, p_titulo_ids uuid[] default null, p_confirmar boolean default false
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulos uuid[];
  v_previa jsonb;
  v_aluno uuid;
  v_acordo_id uuid;
  v_parcela_id uuid;
  v_vinculo jsonb;
  v_pagamento jsonb;
  v_marca text;
  v_depois jsonb;
begin
  -- Portao interno. EXECUTE continua com authenticated: revogar derrubaria a
  -- tela para a propria gestao.
  -- A PORTA DA GESTAO CONTINUA A MESMA. A etapa automatica entra pela segunda
  -- condicao -- `acordo_avista_porta_interna()` --, que exige a chave
  -- transacional E a pilha de chamada da rotina: de fora nao ha como produzir
  -- as duas.
  if not coalesce(public.usuario_e_gestao(), false)
     and not public.acordo_avista_porta_interna() then
    raise exception 'Registrar acordo à vista é decisão da gestão financeira.' using errcode = '42501';
  end if;
  -- sem JWT (rodada horaria ou importacao) o registro assina como sistema
  if v_email = '' then v_email := 'conciliacao@sistema'; end if;

  select array_agg(distinct x) into v_titulos
    from unnest(p_titulo_ids) x where x is not null;
  -- Lista vazia e escolha ("nenhuma"), nao pedido de sugestao: so NULL sugere.
  if p_titulo_ids is not null and v_titulos is null then
    v_titulos := '{}'::uuid[];
  end if;

  if not coalesce(p_confirmar, false) then
    return public.acordo_avista_previa(p_pagamento_id, v_titulos)
           || jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false);
  end if;

  -- Confirmar nunca usa a sugestao: a lista de mensalidades tem de vir escolhida.
  if v_titulos is null or cardinality(v_titulos) = 0 then
    return jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false,
                              'bloqueios', jsonb_build_array('TITULOS_ESCOLHIDOS'),
                              'motivo', 'confirmar exige as mensalidades escolhidas pela gestão');
  end if;

  -- Dois cliques simultaneos no mesmo pagamento: o segundo espera e, ao reler,
  -- encontra o acordo ja criado e e recusado pela previa.
  perform pg_advisory_xact_lock(hashtextextended('acordo_avista:' || p_pagamento_id::text, 0));

  v_previa := public.acordo_avista_previa(p_pagamento_id, v_titulos);

  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('acordo_ulbra:' || (v_previa -> 'acordo_a_criar' ->> 'numero_ulbra'), 0));

  v_aluno := (v_previa -> 'aluno' ->> 'id')::uuid;
  v_marca := 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO | pagamento ' || p_pagamento_id::text
          || ' | boleto ' || (v_previa -> 'parcela_a_criar' ->> 'boleto')
          || ' | confirmado por ' || v_email
          || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');

  -- O ACORDO. Responsavel = operador do pagamento, preenchido na insercao para
  -- que `_acordo_herda_responsavel_do_aluno` nao o troque pelo dono do aluno.
  insert into public.acordos
    (aluno_id, cpf, tipo, forma_pagamento, valor_total, qtd_parcelas, status, unidade, saldo,
     observacao, criado_por_email, criado_por_nome, numero_ulbra,
     operador_responsavel_email, operador_responsavel_nome, criado_em, atualizado_em)
  select a.id, a.cpf, 'ACORDO', 'PARCELADO',
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric, 1, 'ATIVO', a.unidade,
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric,
         v_marca, v_email, 'Recuperação de acordo pago sem importação',
         v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_nome',
         now(), now()
    from public.alunos a
   where a.id = v_aluno
  returning id into v_acordo_id;

  if v_acordo_id is null then
    raise exception 'RECUPERACAO_ABORTADA: o aluno % sumiu entre a previa e a gravacao', v_aluno;
  end if;

  -- A PARCELA, com o boleto do proprio pagamento. `boleto_confiavel` e
  -- verdadeiro porque o numero nao foi inferido: veio impresso no boleto pago.
  insert into public.parcelas
    (acordo_id, numero, valor, vencimento, status, is_entrada, boleto, boleto_confiavel,
     observacao, criado_em, atualizado_em)
  values (v_acordo_id, 1,
          (v_previa -> 'parcela_a_criar' ->> 'valor')::numeric,
          (v_previa -> 'parcela_a_criar' ->> 'vencimento')::date,
          v_previa -> 'parcela_a_criar' ->> 'status',
          false,
          v_previa -> 'parcela_a_criar' ->> 'boleto',
          true, v_marca, now(), now())
  returning id into v_parcela_id;

  -- AS MENSALIDADES, pela funcao que ja existe (as quatro coisas do vinculo).
  v_vinculo := public.vincular_titulos_acordo(v_titulos, v_acordo_id);
  if not coalesce((v_vinculo ->> 'ok')::boolean, false)
     or coalesce((v_vinculo ->> 'vinculados')::int, -1) <> cardinality(v_titulos) then
    raise exception 'RECUPERACAO_ABORTADA: o vínculo das mensalidades não saiu como simulado (%)', v_vinculo::text;
  end if;

  -- O PAGAMENTO, pela funcao que ja existe: grava o aluno e chama o motor, que
  -- encontra a parcela pelo boleto e baixa.
  v_pagamento := public.pagamento_vincular_aluno(p_pagamento_id, v_aluno, v_marca);
  if coalesce(v_pagamento -> 'conciliacao' ->> 'status', '') <> 'BAIXADO' then
    raise exception 'RECUPERACAO_ABORTADA: o motor não baixou a parcela criada (%)', coalesce(v_pagamento::text, 'null');
  end if;

  -- O ESTADO FINAL TEM DE SER O SIMULADO. Qualquer desvio desfaz tudo.
  if not exists (select 1 from public.parcelas
                  where id = v_parcela_id and upper(coalesce(status, '')) = 'PAGO'
                    and origem_baixa_ref = p_pagamento_id::text)
     or not exists (select 1 from public.acordos
                     where id = v_acordo_id and upper(coalesce(status, '')) = 'QUITADO'
                       and lower(coalesce(operador_responsavel_email, ''))
                           = lower(coalesce(v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email', '')))
     or exists (select 1 from public.acordos_titulos
                 where id = any(v_titulos) and upper(coalesce(situacao, '')) <> 'PAGO') then
    raise exception 'RECUPERACAO_ABORTADA: o estado final difere do simulado para o pagamento %', p_pagamento_id;
  end if;

  select jsonb_build_object(
    'pagamento', (select jsonb_build_object('status_conciliacao', p.status_conciliacao, 'aluno_id', p.aluno_id,
                                            'origem_vinculo', p.origem_vinculo)
                    from public.pagamentos p where p.id = p_pagamento_id),
    'fila', (select jsonb_build_object('decisao', f.decisao, 'decidido_por', f.decidido_por)
               from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id),
    'acordo', (select jsonb_build_object('id', a.id, 'numero_ulbra', a.numero_ulbra, 'status', a.status,
                                         'operador_responsavel_email', a.operador_responsavel_email)
                 from public.acordos a where a.id = v_acordo_id),
    'parcela', (select jsonb_build_object('id', q.id, 'status', q.status, 'boleto', q.boleto,
                                          'confirmado_por_email', q.confirmado_por_email, 'origem_baixa', q.origem_baixa)
                  from public.parcelas q where q.id = v_parcela_id),
    'titulos', (select jsonb_agg(jsonb_build_object('id', t.id, 'documento', t.documento,
                                                    'situacao', t.situacao, 'status', t.status))
                  from public.acordos_titulos t where t.id = any(v_titulos)),
    'aluno', (select jsonb_build_object('saldo_total', a.saldo_total, 'situacao_operacional', a.situacao_operacional,
                                        'status_atual', a.status_atual,
                                        'responsavel_atual_email', a.responsavel_atual_email)
                from public.alunos a where a.id = v_aluno),
    'confirmacoes_pendentes', (select count(*) from public.solicitacoes_confirmacao_pagamento s
                                where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO'))
  into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO', 'acordos', v_acordo_id,
          jsonb_build_object(
            'origem', 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO',
            'confirmado_por', v_email,
            'confirmado_em', now(),
            'pagamento_id', p_pagamento_id,
            'acordo_id', v_acordo_id,
            'numero_ulbra', v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
            'parcela_id', v_parcela_id,
            'titulo_ids', to_jsonb(v_titulos),
            'operador_original', v_previa -> 'credito',
            'estado_antes', v_previa,
            'estado_depois', v_depois));

  return v_previa || jsonb_build_object(
    'ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
    'acordo_id', v_acordo_id, 'parcela_id', v_parcela_id,
    'estado_depois', v_depois);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3b. A cadeia que o registrador ja usa ganha a mesma porta de maquina
-- ---------------------------------------------------------------------------
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
  v_bloqueados uuid[];
  v_novos uuid[];
  v_ja int := 0;
  v_n int := 0;
begin
  -- A ETAPA AUTOMATICA DO ACORDO A VISTA assina como sistema. A porta e a
  -- mesma de `acordo_avista_registrar`: chave transacional + pilha de chamada.
  -- Esta funcao tem um unico chamador, o registrador do acordo a vista.
  if v_email = '' and public.acordo_avista_porta_interna() then
    v_email := 'conciliacao@sistema';
  end if;
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- Cadeado sem fila: se o acordo esta em uso, volta agora, sem ter escrito
  -- nada. Antes esperava e morria nos 8s -- sem saber se gravou ou nao.
  if not pg_try_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0)) then
    return jsonb_build_object('ok',false,'erro','ACORDO_EM_USO');
  end if;

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  -- Ja esta neste mesmo acordo: nao e erro, e trabalho ja feito.
  -- `coalesce` obrigatorio: em titulo sem acordo, `t.acordo_id = p_acordo_id` da
  -- NULL (nao `false`), e `not NULL` e NULL -- a linha sumia da lista de novos e
  -- a funcao respondia "0 vinculados" sem vincular nada. Pego no teste.
  select count(*) into v_ja
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  select array_agg(t.id) into v_novos
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  if v_novos is null or array_length(v_novos,1) is null then
    -- tudo que veio ja estava vinculado a este acordo
    return jsonb_build_object('ok', true, 'vinculados', 0, 'ja_estavam', v_ja,
                              'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo);
  end if;

  -- mesmo cuidado com NULL aqui: titulo sem aluno_id daria NULL e escaparia da
  -- lista de bloqueados em vez de ser barrado.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(v_novos)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    , false);

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS',
                              'bloqueados', to_jsonb(v_bloqueados), 'ja_estavam', v_ja);
  end if;

  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  if v_quitado then
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
  else
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
  end if;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'ja_estavam', v_ja,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'ja_estavam', v_ja,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$fn$;

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
  -- A porta da gestao e a do service_role continuam as mesmas; a terceira e a
  -- da etapa automatica do acordo a vista, que so existe dentro dela.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.acordo_avista_porta_interna() then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''),
                      case when public.acordo_avista_porta_interna()
                           then 'conciliacao@sistema' else 'gestao' end);

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

-- ---------------------------------------------------------------------------
-- 4. A rodada horaria
-- ---------------------------------------------------------------------------
create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    -- parcela paga antes da extracao, em acordo que ja entrou (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='reconstruir_parcela_paga_antes';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('reconstruir_parcela_paga_antes', public.parcela_paga_antes_reconstruir_pendentes(50));
    end if;

    -- parcela ja paga com o dinheiro refletido: so fecha a pendencia (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='encerrar_ja_paga_conferida';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('encerrar_ja_paga_conferida', public.conciliacao_ja_paga_encerrar_pendentes(50));
    end if;

    -- acordo a vista pago antes de existir no CRM (17/09/2026): a previa do
    -- botao aprova, o registrador da gestao grava e o motor baixa.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='recuperar_acordo_avista';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('recuperar_acordo_avista', public.acordo_avista_recuperar_pendentes(25));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. A importacao de pagamentos
-- ---------------------------------------------------------------------------
create or replace function public._pagamentos_baixar_lote()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_res jsonb; v_liga boolean;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    -- a baixa e melhoria, nao condicao: a importacao nao pode cair por causa
    -- dela. Fica o registro para alguem olhar.
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;

  -- PARCELA PAGA ANTES DA EXTRACAO (17/09/2026). So depois de o motor ter
  -- feito o que dava: o que sobrou sem parcela para o boleto, em acordo que ja
  -- existe, passa pela previa estrutural. Falha aqui tambem nao derruba a
  -- importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes';
  if coalesce(v_liga, false) then
    begin
      perform public.parcela_paga_antes_reconstruir_pendentes(50);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECONSTRUCAO_PARCELA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;

  -- ACORDO A VISTA PAGO ANTES DE EXISTIR NO CRM (17/09/2026). Depois de tudo:
  -- o que sobrou em AGUARDANDO_ACORDO, com boleto de parcela unica e sem
  -- acordo no CRM, passa pela previa do botao. Falha aqui tambem nao derruba
  -- a importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista';
  if coalesce(v_liga, false) then
    begin
      perform public.acordo_avista_recuperar_pendentes(25);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECUPERACAO_AVISTA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;
  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. A ETAPA NASCE DESLIGADA, com chave propria
-- ---------------------------------------------------------------------------
insert into public.fluxo_pagamentos_config (etapa, ligado, observacao, alterado_em, alterado_por)
values ('recuperar_acordo_avista', false,
        'DESLIGADA ao entrar (17/09/2026). Recupera o acordo a vista pago antes da importacao: a previa do botao aprova, o registrador da gestao grava e o motor baixa. Desligar aqui para a recuperacao sem parar importacao, baixa, reconstrucao nem as outras etapas.',
        now(), 'migration_20260917230000')
on conflict (etapa) do nothing;

revoke all on function public.acordo_avista_porta_interna() from public, anon, authenticated;
revoke all on function public.acordo_avista_recuperar_um(uuid, boolean) from public, anon, authenticated;
revoke all on function public.acordo_avista_recuperar_pendentes(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PROVA. Qualquer divergencia aborta a migration inteira.
-- ---------------------------------------------------------------------------
do $prova$
declare v_src text;
begin
  -- a previa do botao e o motor de baixa continuam sendo os de producao
  if md5((select prosrc from pg_proc where oid = 'public.acordo_avista_previa(uuid,uuid[])'::regprocedure)) <> '9e062e7600cd7b04a17fb9db65469bfe' then
    raise exception 'PROVA: a previa do acordo a vista nao e a de producao de 17/09/2026';
  end if;
  if md5((select prosrc from pg_proc where oid = 'public.pagamento_conciliar_um(uuid,boolean)'::regprocedure)) <> 'fa3d64add73e0e73e587e16f0c0624d1' then
    raise exception 'PROVA: o motor de baixa nao e o de producao de 17/09/2026';
  end if;
  if md5((select prosrc from pg_proc where oid = 'public.parcela_paga_antes_reconstruir(uuid,boolean)'::regprocedure)) <> '0bd85569a834454244abb5ea97f068a2' then
    raise exception 'PROVA: a reconstrucao da parcela paga antes da extracao mudou';
  end if;
  if md5((select prosrc from pg_proc where oid = 'public.conciliacao_ja_paga_encerrar(uuid,boolean)'::regprocedure)) <> '6d546fa2c013e5f7c74ca7757ea6811f' then
    raise exception 'PROVA: o encerramento da parcela ja paga mudou';
  end if;

  -- a etapa automatica nao e porta de entrada; o botao da gestao continua sendo
  if has_function_privilege('authenticated', 'public.acordo_avista_porta_interna()', 'EXECUTE')
     or has_function_privilege('anon', 'public.acordo_avista_porta_interna()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acordo_avista_recuperar_um(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acordo_avista_recuperar_pendentes(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.acordo_avista_registrar(uuid,uuid[],boolean)', 'EXECUTE') then
    raise exception 'PROVA: permissao errada nas funcoes da recuperacao';
  end if;
  if not has_function_privilege('authenticated', 'public.acordo_avista_registrar(uuid,uuid[],boolean)', 'EXECUTE') then
    raise exception 'PROVA: a gestao perdeu o botao de registrar acordo a vista';
  end if;

  -- o registrador continua exigindo a gestao antes de qualquer escrita
  select prosrc into v_src from pg_proc where oid = 'public.acordo_avista_registrar(uuid,uuid[],boolean)'::regprocedure;
  if position('usuario_e_gestao' in v_src) = 0
     or position('usuario_e_gestao' in v_src) > position('insert into public.acordos' in v_src) then
    raise exception 'PROVA: acordo_avista_registrar perdeu o portao da gestao';
  end if;
  if position('acordo_avista_previa' in v_src) = 0 then
    raise exception 'PROVA: acordo_avista_registrar deixou de refazer a previa';
  end if;

  -- a etapa nova roda depois das que ja existiam, e nasce desligada
  select prosrc into v_src from pg_proc where oid = 'public.fluxo_pagamentos_rodar(text)'::regprocedure;
  if position('acordo_avista_recuperar_pendentes' in v_src) < position('conciliacao_ja_paga_encerrar_pendentes' in v_src) then
    raise exception 'PROVA: a recuperacao roda antes das etapas anteriores';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista') is distinct from false then
    raise exception 'PROVA: etapa recuperar_acordo_avista ausente ou ligada';
  end if;

  -- a porta so e verdadeira dentro da rotina: aqui fora, com a chave acesa, e falsa
  perform set_config('reativa.recuperacao_avista', 'on', true);
  if public.acordo_avista_porta_interna() then
    raise exception 'PROVA: a porta de maquina abre fora da rotina';
  end if;
  perform set_config('reativa.recuperacao_avista', 'off', true);

  -- a recuperacao nao escreve em tabela financeira por conta propria
  for v_src in select prosrc from pg_proc
                where oid in ('public.acordo_avista_recuperar_um(uuid,boolean)'::regprocedure,
                              'public.acordo_avista_recuperar_pendentes(integer)'::regprocedure) loop
    if v_src ~* '(insert\s+into|update|delete\s+from)\s+public\.(parcelas|acordos|acordos_titulos|baixas_pagamento|acordo_titulo_vinculo|pagamentos)\M' then
      raise exception 'PROVA: a recuperacao escreve direto em tabela financeira';
    end if;
  end loop;
end;
$prova$;
