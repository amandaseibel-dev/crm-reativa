-- ENCAMINHAMENTO DA PENDÊNCIA JÁ CLASSIFICADA -- a ação declarada vira porta
-- =============================================================================
-- ETAPA 2 da frente de conciliação inteligente, autorizada em 26/10/2026.
--
-- O PROBLEMA, medido em produção em 26/10/2026 (somente leitura):
--
--   `vw_fila_pagamento_triagem` declara uma ação para 89 pagamentos e NENHUMA
--   tela a oferece:
--
--     ja_paga_conferir_e_encerrar   CONFERIR_E_ENCERRAR   47   R$ 40.663,34
--     escolher_aluno_sugerido       ESCOLHER_ALUNO        42   R$ 23.469,07
--
--   As funções que resolveriam cada uma existem e são chamadas por ninguém:
--   `conciliacao_ja_paga_previa` e `conciliacao_ja_paga_encerrar` têm ZERO
--   chamadas no frontend -- e não poderiam ter, porque não têm `grant execute`
--   para `authenticated` (medido: só `postgres` e `service_role`). A tela não
--   as alcança. Dar-lhes esse grant seria o caminho errado: elas NÃO têm portão
--   interno de permissão, então o grant as abriria a qualquer pessoa logada --
--   exatamente o furo das sete SECURITY DEFINER da PR #729.
--
-- O QUE ESTA MIGRATION FAZ. Duas funções de FACHADA, com portão próprio, que
-- orquestram o que já existe. Nenhum motor novo, nenhuma regra financeira nova,
-- nenhuma fila nova, nenhuma tabela nova:
--
--   1. `conciliacao_encaminhar_previa`     -- só leitura, devolve a ação
--      proposta, as evidências, o motivo e o resultado esperado;
--   2. `conciliacao_encaminhar_confirmar`  -- executa, e só depois de conferir.
--
-- POR QUE A FACHADA É SECURITY DEFINER E ISSO NÃO É UM FURO. Ela roda como
-- `postgres` e por isso ALCANÇA as duas funções sem portão -- é justamente o
-- que permite NÃO dar grant a elas. O portão passa a viver num lugar só, aqui,
-- e `usuario_e_gestao()` continua sendo lida da JWT de quem chamou, porque
-- SECURITY DEFINER troca o papel do banco, não o `auth.jwt()`.
--
-- O ENCADEAMENTO QUE EVITA O LIMBO -- é a razão de a Etapa 1 ter vindo antes.
-- `conciliacao_ja_paga_encerrar` grava SÓ a decisão da fila e não toca
-- `pagamentos.status_conciliacao` (por desenho: não há dinheiro a mover). Usada
-- sozinha, ela produz exatamente os 33 casos de pendência decidida e eternamente
-- pendente que a Etapa 1 foi feita para encerrar. Então aqui ela NUNCA é usada
-- sozinha: o `CONFERIR_E_ENCERRAR` chama as duas em sequência, na MESMA
-- transação --
--
--     conciliacao_ja_paga_encerrar            (grava a decisão + auditoria)
--     conciliacao_encerrar_sem_efeito_financeiro  (move ao estado terminal)
--
-- -- e se a segunda recusar, a função levanta exceção e a PRIMEIRA é desfeita
-- com ela. Ou o pagamento sai inteiro da pendência, ou nada é gravado. Não há
-- caminho, nesta função, que deixe uma decisão sem saída. A atomicidade é a
-- garantia, não a boa intenção.
--
-- POR QUE A SEGUNDA ACEITA O QUE A PRIMEIRA ACABOU DE GRAVAR.
-- `conciliacao_encerrar_sem_efeito_financeiro` exige rastro em `auditoria` com
-- `sem_efeito_financeiro = true`; `conciliacao_ja_paga_encerrar` grava esse
-- rastro. Na mesma transação a linha já é visível para o `select exists`, então
-- a prova existe quando a segunda a procura.
--
-- O QUE ESTA MIGRATION NÃO FAZ
--   - não dá baixa, não quita, não altera parcela, acordo, título ou saldo:
--     toda escrita em dado é a da Etapa 1 (uma coluna de controle) e a do
--     vínculo de aluno, que já era função existente e já exigia gestão;
--   - não reatribui caso, dono nem responsável;
--   - não religa job nem `consulta_portador`;
--   - não aceita ação que a triagem não tenha declarado para aquele pagamento
--     -- `p_acao` é CONFERIDO contra `acao_sugerida`, não obedecido;
--   - não executa o backfill dos 33 (continua exigindo autorização própria);
--   - não cria fila, tabela, view nem estado novo;
--   - não toca nas funções de E5/E6/E7 nem da Efetividade.
--
-- PERMISSÃO -- "gestão e Administrativo", conferido em 26/10/2026 em vez de
-- suposto. `usuario_e_gestao()` é allowlist de três e-mails, e a coluna
-- `usuarios.pode_gerir_confirmacao_pagamento` está `true` para exatamente esses
-- três -- e um deles, `cobranca07@aelbra.com.br`, É o perfil `administrativo`:
--
--     gerencia       amanda.seibel@aelbra.com.br   pode_gerir = true
--     supervisor     cobranca04@aelbra.com.br      pode_gerir = true
--     administrativo cobranca07@aelbra.com.br      pode_gerir = true
--     (os outros 11 usuários, inclusive os 7 operadores ativos)  false
--
-- Os dois conjuntos são o MESMO conjunto hoje. Por isso o portão é
-- `usuario_e_gestao()` nas duas funções: o Administrativo já passa, e trocar o
-- predicado por um que leia a coluna AMPLIARIA a permissão no dia em que alguém
-- ligasse a flag para um operador -- decisão de permissão que não foi pedida.
-- Reutilizar o controle existente é também o requisito 1.
--
-- IDEMPOTÊNCIA. Herdada e conferida, não reinventada: `ja_paga_encerrar` só
-- grava `where decisao is null` e aborta se mudou; `encerrar_sem_efeito_financeiro`
-- devolve `JA_ENCERRADO` sem reescrever; e a fachada relê a triagem depois do
-- lock. Chamar duas vezes não produz duas decisões nem duas auditorias de
-- estado.
--
-- ROLLBACK: supabase/rollbacks/20261026160000_conciliacao_encaminhamento_etapa2.rollback.sql
--
-- ESTA MIGRATION NÃO FOI APLICADA EM PRODUÇÃO.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A PRÉVIA: a pessoa vê a ação, a evidência, o motivo e o resultado
-- -----------------------------------------------------------------------------
-- É o requisito "exibir antes de confirmar", e ela é `stable`: não há caminho
-- de escrita aqui. Devolve o vocabulário fechado que a tela traduz, nunca uma
-- frase montada no banco para a tela repetir sem entender.
--
-- `resultado_esperado` é CÓDIGO, não texto de interface. O texto vive em
-- `src/utils/encaminhamentoConciliacao.js`, para a tela e o teste lerem o mesmo
-- vocabulário -- mesma decisão de `conciliacaoPagamento.js`.
create or replace function public.conciliacao_encaminhar_previa(
  p_pagamento_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_t      record;
  v_previa jsonb;
  v_sug    jsonb;
begin
  -- O PORTÃO RECUSA IDENTIDADE NULA. `coalesce(..., false)`: `NULL and ...`
  -- avalia para NULL, o `if` não dispara e a função seguiria com autoria nula.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encaminhar pendencia de conciliacao e decisao da gestao.'
      using errcode = '42501';
  end if;

  select t.pagamento_id, t.categoria, t.subcategoria, t.acao_sugerida, t.motivo,
         t.decisao, t.status_conciliacao, t.valor_pago, t.data_pagamento,
         t.boleto, t.aluno_id, t.sugestoes
    into v_t
    from public.vw_fila_pagamento_triagem t
   where t.pagamento_id = p_pagamento_id;

  if not found then
    -- Fora da triagem é fora da pendência: pode já ter saído, ou nunca ter
    -- entrado. A tela não deve oferecer ação para algo que a classificação não
    -- reconhece como pendente.
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_NA_TRIAGEM',
                              'gravou', false);
  end if;

  if v_t.acao_sugerida is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ACAO_SUGERIDA',
                              'subcategoria', v_t.subcategoria,
                              'categoria', v_t.categoria,
                              'motivo_da_pendencia', v_t.motivo,
                              'gravou', false);
  end if;

  -- A EVIDÊNCIA, por ação. Cada ramo usa a prova que já existe para aquele
  -- caso; nenhuma evidência é montada aqui.
  if v_t.acao_sugerida = 'CONFERIR_E_ENCERRAR' then
    -- As 8 validações nomeadas de `PARCELA_JA_PAGA_CONFERIDA`, com `aprovado`
    -- e `bloqueios`. É SQL puro e sem DML, por isso cabe numa função `stable`.
    v_previa := public.conciliacao_ja_paga_previa(p_pagamento_id);
    return jsonb_build_object(
      'ok', true, 'gravou', false, 'modo', 'PREVIA',
      'acao', v_t.acao_sugerida,
      'categoria', v_t.categoria,
      'subcategoria', v_t.subcategoria,
      'motivo_da_pendencia', v_t.motivo,
      'aprovado', coalesce((v_previa ->> 'aprovado')::boolean, false),
      'bloqueios', coalesce(v_previa -> 'bloqueios', '[]'::jsonb),
      'validacoes', coalesce(v_previa -> 'validacoes', '[]'::jsonb),
      'pagamento', v_previa -> 'pagamento',
      'parcela', v_previa -> 'parcela',
      'acordo', v_previa -> 'acordo',
      'evidencia', v_previa -> 'evidencia',
      -- O que vai acontecer, em código. Os DOIS passos, nomeados: esconder o
      -- segundo faria a pessoa aprovar metade do que a função executa.
      'passos', jsonb_build_array('REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO',
                                  'MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO'),
      'resultado_esperado', 'PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO',
      'efeito_financeiro', false);
  end if;

  if v_t.acao_sugerida = 'ESCOLHER_ALUNO' then
    -- As sugestões são as da fila, como estão. Oferecidas, nunca aplicadas: a
    -- confirmação exige que a pessoa diga QUAL, e o aluno escolhido é conferido
    -- contra esta lista.
    v_sug := coalesce(v_t.sugestoes, '[]'::jsonb);
    return jsonb_build_object(
      'ok', true, 'gravou', false, 'modo', 'PREVIA',
      'acao', v_t.acao_sugerida,
      'categoria', v_t.categoria,
      'subcategoria', v_t.subcategoria,
      'motivo_da_pendencia', v_t.motivo,
      'aprovado', jsonb_array_length(v_sug) > 0,
      'bloqueios', case when jsonb_array_length(v_sug) > 0
                        then '[]'::jsonb
                        else jsonb_build_array('SEM_SUGESTAO_DE_ALUNO') end,
      'sugestoes', v_sug,
      'pagamento', jsonb_build_object('id', v_t.pagamento_id, 'boleto', v_t.boleto,
                                      'valor_pago', v_t.valor_pago,
                                      'data_pagamento', v_t.data_pagamento,
                                      'status_conciliacao', v_t.status_conciliacao,
                                      'aluno_id', v_t.aluno_id),
      'passos', jsonb_build_array('VINCULAR_ALUNO_ESCOLHIDO'),
      'resultado_esperado', 'PAGAMENTO_VINCULADO_AO_ALUNO',
      -- Vincular aluno NÃO baixa parcela nem altera saldo: diz de quem é o
      -- dinheiro que já estava lançado. O aviso da tela repete isto.
      'efeito_financeiro', false);
  end if;

  -- Ação declarada que esta função não implementa. Recusa nomeada em vez de
  -- silêncio: é assim que a próxima ação da triagem aparece como pendência de
  -- desenvolvimento, e não como botão que não faz nada.
  return jsonb_build_object('ok', false, 'motivo', 'ACAO_NAO_IMPLEMENTADA',
                            'acao', v_t.acao_sugerida, 'gravou', false);
end;
$function$;

comment on function public.conciliacao_encaminhar_previa(uuid) is
  'Previa do encaminhamento da pendencia ja classificada: devolve a acao que '
  'vw_fila_pagamento_triagem declara, as evidencias daquele caso, o motivo e o '
  'resultado esperado em codigo. Portao de gestao (que inclui o perfil '
  'administrativo). Somente leitura: nao grava nada, nunca.';

revoke all on function public.conciliacao_encaminhar_previa(uuid) from public;
revoke all on function public.conciliacao_encaminhar_previa(uuid) from anon;
grant execute on function public.conciliacao_encaminhar_previa(uuid) to authenticated;
grant execute on function public.conciliacao_encaminhar_previa(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 2. A CONFIRMAÇÃO: executa o que a triagem declarou, e nada além
-- -----------------------------------------------------------------------------
-- `p_confirmar` default FALSE: a chamada crua devolve a prévia e não grava. É o
-- padrão de `conciliacao_ja_paga_encerrar` e de
-- `conciliacao_encerrar_sem_efeito_financeiro`.
create or replace function public.conciliacao_encaminhar_confirmar(
  p_pagamento_id uuid,
  p_acao         text,
  p_aluno_id     uuid    default null,
  p_confirmar    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_previa jsonb;
  v_acao   text;
  v_sug    jsonb;
  v_r1     jsonb;
  v_r2     jsonb;
  v_email  text;
  v_obs    text;
  v_st     text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encaminhar pendencia de conciliacao e decisao da gestao.'
      using errcode = '42501';
  end if;

  -- A PRÉVIA É A FONTE DA AÇÃO, e é relida aqui mesmo quando a tela já a
  -- mostrou: o que a tela viu pode ter envelhecido, e quem decide o que é
  -- possível é o banco no instante da gravação.
  v_previa := public.conciliacao_encaminhar_previa(p_pagamento_id);
  if not coalesce((v_previa ->> 'ok')::boolean, false) then
    return v_previa || jsonb_build_object('gravou', false, 'modo', 'RECUSADO');
  end if;

  v_acao := v_previa ->> 'acao';

  -- `p_acao` É CONFERIDO, NÃO OBEDECIDO. A tela manda o que viu; se a
  -- classificação mudou nesse intervalo, a função recusa em vez de executar a
  -- ação antiga sobre o caso novo.
  if coalesce(p_acao,'') <> v_acao then
    return jsonb_build_object('ok', false, 'motivo', 'ACAO_DIVERGE_DA_SUGERIDA',
                              'acao_pedida', p_acao, 'acao_sugerida', v_acao,
                              'gravou', false, 'modo', 'RECUSADO');
  end if;

  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO',
                                          'gravou', false);
  end if;

  -- ESCOLHER_ALUNO precisa do aluno ANTES da prévia valer como aprovação: a
  -- lista ter sugestão não diz qual delas a pessoa escolheu.
  if v_acao = 'ESCOLHER_ALUNO' then
    if p_aluno_id is null then
      return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_INFORMADO',
                                'gravou', false, 'modo', 'RECUSADO');
    end if;
    v_sug := coalesce(v_previa -> 'sugestoes', '[]'::jsonb);
    -- O aluno tem de estar NA LISTA que a fila sugeriu. Aceitar um id qualquer
    -- transformaria a porta do encaminhamento num vínculo livre, que é outra
    -- ação, com outra tela e outro aviso (a busca manual, que já existe).
    if not exists (select 1 from jsonb_array_elements(v_sug) s
                    where (s ->> 'aluno_id')::uuid = p_aluno_id) then
      return jsonb_build_object('ok', false, 'motivo', 'ALUNO_FORA_DAS_SUGESTOES',
                                'aluno_id', p_aluno_id, 'sugestoes', v_sug,
                                'gravou', false, 'modo', 'RECUSADO');
    end if;
  end if;

  if not coalesce(p_confirmar, false) then
    return v_previa || jsonb_build_object('modo', 'SIMULACAO', 'gravou', false,
                                          'aluno_id', p_aluno_id);
  end if;

  -- Duas telas ao mesmo tempo no mesmo pagamento: a segunda espera e, ao
  -- reler, encontra o caso já resolvido e é recusada pelas funções internas.
  perform pg_advisory_xact_lock(
    hashtextextended('conciliacao_encaminhar:' || p_pagamento_id::text, 0));

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  if v_acao = 'CONFERIR_E_ENCERRAR' then
    -- PASSO 1 -- a decisão da fila. Grava `RESOLVIDO_AUTOMATICO` e a auditoria
    -- com `sem_efeito_financeiro: true`. Não toca parcela, acordo nem saldo.
    v_r1 := public.conciliacao_ja_paga_encerrar(p_pagamento_id, true);
    if not coalesce((v_r1 ->> 'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'motivo', 'PASSO_1_RECUSADO',
                                'detalhe', coalesce(v_r1 -> 'bloqueios', '[]'::jsonb),
                                'passo_1', v_r1, 'gravou', false, 'modo', 'RECUSADO');
    end if;

    -- PASSO 2 -- a saída terminal da Etapa 1. SEM ELE o passo 1 vira limbo.
    v_r2 := public.conciliacao_encerrar_sem_efeito_financeiro(p_pagamento_id, true);
    if not coalesce((v_r2 ->> 'ok')::boolean, false) then
      -- ATOMICIDADE É A GARANTIA. A exceção desfaz o passo 1 junto: ou o
      -- pagamento sai inteiro da pendência, ou nada foi gravado. É o que
      -- impede esta função de criar mais um dos 33 casos.
      raise exception
        'ENCAMINHAMENTO_ABORTADO: a saida terminal recusou (%); a decisao do passo 1 foi desfeita',
        coalesce(v_r2 ->> 'motivo', 'motivo nao informado');
    end if;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (v_email, 'CONCILIACAO_ENCAMINHAMENTO', 'pagamentos', p_pagamento_id,
            jsonb_build_object('pagamento_id', p_pagamento_id,
                               'acao', v_acao,
                               'origem', 'FILA_PAGAMENTO_ENCAMINHAMENTO',
                               'passo_1', v_r1 -> 'estado_depois',
                               'passo_2', v_r2 -> 'status_conciliacao',
                               'sem_efeito_financeiro', true));

    return jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
                              'acao', v_acao,
                              'pagamento_id', p_pagamento_id,
                              'resultado', 'PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO',
                              'status_conciliacao', v_r2 ->> 'status_conciliacao',
                              'passo_1', v_r1 -> 'estado_depois',
                              'passo_2', v_r2 - 'estado_anterior',
                              'efeito_financeiro', false);
  end if;

  if v_acao = 'ESCOLHER_ALUNO' then
    v_obs := 'Encaminhamento da fila de conciliacao (Etapa 2): aluno escolhido entre as '
             || jsonb_array_length(coalesce(v_previa -> 'sugestoes','[]'::jsonb))::text
             || ' sugestoes da fila. Boleto ' || coalesce(v_previa -> 'pagamento' ->> 'boleto', '(sem)')
             || '. Motivo da pendencia: ' || coalesce(v_previa ->> 'motivo_da_pendencia', '(sem)') || '.';

    -- Função EXISTENTE, com portão próprio de gestão, que grava
    -- `origem_vinculo = 'GESTAO_MANUAL'` e fecha a linha da fila com quem
    -- decidiu e quando. Não baixa parcela e não altera saldo.
    v_r1 := public.pagamento_vincular_aluno(p_pagamento_id, p_aluno_id, v_obs);
    if not coalesce((v_r1 ->> 'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'motivo', 'VINCULO_RECUSADO',
                                'detalhe', v_r1, 'gravou', false, 'modo', 'RECUSADO');
    end if;

    select p.status_conciliacao into v_st
      from public.pagamentos p where p.id = p_pagamento_id;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (v_email, 'CONCILIACAO_ENCAMINHAMENTO', 'pagamentos', p_pagamento_id,
            jsonb_build_object('pagamento_id', p_pagamento_id,
                               'acao', v_acao,
                               'origem', 'FILA_PAGAMENTO_ENCAMINHAMENTO',
                               'aluno_id', p_aluno_id,
                               'resultado_vinculo', v_r1,
                               'sem_efeito_financeiro', true));

    return jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
                              'acao', v_acao,
                              'pagamento_id', p_pagamento_id,
                              'aluno_id', p_aluno_id,
                              'resultado', 'PAGAMENTO_VINCULADO_AO_ALUNO',
                              -- O vínculo NÃO encerra a conciliação: o
                              -- pagamento segue no estado em que estava, e a
                              -- rodada volta a avaliá-lo com o aluno certo.
                              'status_conciliacao', v_st,
                              'efeito_financeiro', false);
  end if;

  return jsonb_build_object('ok', false, 'motivo', 'ACAO_NAO_IMPLEMENTADA',
                            'acao', v_acao, 'gravou', false, 'modo', 'RECUSADO');
end;
$function$;

comment on function public.conciliacao_encaminhar_confirmar(uuid, text, uuid, boolean) is
  'Executa a acao que vw_fila_pagamento_triagem declarou para a pendencia, reusando '
  'as funcoes existentes. CONFERIR_E_ENCERRAR encadeia conciliacao_ja_paga_encerrar e '
  'conciliacao_encerrar_sem_efeito_financeiro na MESMA transacao -- se a segunda recusar, '
  'a primeira e desfeita, para nao criar pendencia decidida sem saida. ESCOLHER_ALUNO '
  'exige aluno dentre as sugestoes da fila e chama pagamento_vincular_aluno. Portao de '
  'gestao, p_confirmar=false devolve previa, p_acao e conferido contra a sugerida. '
  'Nao da baixa, nao quita, nao reatribui e nao altera parcela, acordo, titulo ou saldo.';

revoke all on function public.conciliacao_encaminhar_confirmar(uuid, text, uuid, boolean) from public;
revoke all on function public.conciliacao_encaminhar_confirmar(uuid, text, uuid, boolean) from anon;
grant execute on function public.conciliacao_encaminhar_confirmar(uuid, text, uuid, boolean) to authenticated;
grant execute on function public.conciliacao_encaminhar_confirmar(uuid, text, uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 3. O QUE CONTINUA SEM GRANT, DE PROPÓSITO
-- -----------------------------------------------------------------------------
-- `conciliacao_ja_paga_previa` e `conciliacao_ja_paga_encerrar` seguem SEM
-- `grant execute` para `authenticated`. A fachada as alcança por ser SECURITY
-- DEFINER; o frontend não as alcança, e é assim que fica. Esta migration não
-- concede grant nenhum a elas -- a ausência é a proteção, e está escrita aqui
-- para que remover a fachada no futuro não pareça motivo para abri-las.
