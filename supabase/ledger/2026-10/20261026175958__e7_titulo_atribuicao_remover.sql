create or replace function public.titulo_atribuicao_remover(
  p_titulo_id uuid,
  p_acordo_id uuid,
  p_motivo    text    default null,
  p_confirmar boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_lote     constant text    := 'REMOVER_ATRIBUICAO_SEM_LASTRO';
  v_tol      constant numeric := 0.005;
  v_t            record;
  v_ac           record;
  v_vinc         record;
  v_t2           record;
  v_vinc2        record;
  v_depois       record;
  v_motivo       text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_email        text;
  v_valor        numeric;
  v_recebido     numeric;
  v_quit_antes   numeric;
  v_quit_depois  numeric;
  v_desc_antes   numeric;
  v_desc_depois  numeric;
  v_pag          text;
  v_antes        jsonb;
  v_cobertura    jsonb;
  v_enc          boolean;
  v_n            int;
  v_texto        text;
begin
  -- G0. O PORTÃO RECUSA IDENTIDADE NULA. `coalesce(..., false)` em vez da
  -- chamada crua: `NULL and ...` avalia para NULL, que não é TRUE, o `if` não
  -- dispararia e a função seguiria com autoria nula (lição dos PR #727/#729).
  --
  -- GESTÃO **ou** DIRETORIA, como a gestão pediu em 26/10/2026.
  -- `usuario_e_gestao()` é allowlist de e-mail; `usuario_e_diretoria()` lê
  -- `usuarios.perfil = 'diretoria'` com `ativo is true` (2 pessoas ativas em
  -- produção hoje). São conjuntos distintos: quem é diretoria não está na
  -- allowlist, e exigir só a allowlist deixaria a diretoria de fora.
  if not coalesce(public.usuario_e_gestao(), false)
     and not coalesce(public.usuario_e_diretoria(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Retirar atribuicao de mensalidade e decisao da gestao financeira ou da diretoria.'
      using errcode = '42501';
  end if;

  if p_titulo_id is null or p_acordo_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'PARAMETROS_INCOMPLETOS',
      'detalhe', 'informe o titulo e o acordo do qual a atribuicao sai', 'gravou', false);
  end if;

  select t.id, t.aluno_id, t.documento, t.situacao, t.status, t.acordo_id, t.tipo_boleto,
         t.origem_liquidacao, t.origem_liquidacao_ref, t.origem_encerramento,
         coalesce(t.valor_original, t.saldo_corrigido, t.valor_em_aberto, 0) as valor
    into v_t
    from public.acordos_titulos t
   where t.id = p_titulo_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'TITULO_NAO_ENCONTRADO', 'gravou', false);
  end if;
  v_valor := v_t.valor;

  -- IDEMPOTÊNCIA, antes das guardas de estado. Já em ABERTO, sem vínculo ativo
  -- e sem apontar para o acordo: o trabalho está feito. Devolve ok sem
  -- reescrever e sem auditar de novo.
  if upper(coalesce(v_t.situacao, '')) = 'ABERTO'
     and lower(coalesce(v_t.status, '')) = 'em_aberto'
     and v_t.acordo_id is null
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = p_titulo_id and v.acordo_id = p_acordo_id
                        and coalesce(v.ativo, true)) then
    return jsonb_build_object('ok', true, 'motivo', 'JA_REMOVIDO', 'gravou', false,
      'titulo_id', p_titulo_id, 'documento', v_t.documento,
      'situacao', v_t.situacao, 'status', v_t.status);
  end if;

  -- G1. Só desfaz o que está de fato quitado, e pelo PAR de colunas: uma
  -- combinação meio-quitada é incoerência de outro problema, não deste.
  if upper(coalesce(v_t.situacao, '')) <> 'PAGO'
     or lower(coalesce(v_t.status, '')) <> 'quitada' then
    return jsonb_build_object('ok', false, 'motivo', 'NAO_ESTA_QUITADO', 'gravou', false,
      'situacao', coalesce(v_t.situacao, '(null)'), 'status', coalesce(v_t.status, '(null)'));
  end if;

  -- G2. LIQUIDAÇÃO OFICIAL COMPROVADA É TERMINAL. O gatilho
  -- `titulo_liquidado_na_origem_e_terminal` também coage de volta, mas recusar
  -- aqui, com nome, é diferente de ser desfeito em silêncio depois de escrever.
  if coalesce(v_t.origem_liquidacao, '') = 'PRIME_LIQUIDACAO_OFICIAL' then
    return jsonb_build_object('ok', false, 'motivo', 'LIQUIDACAO_OFICIAL_COMPROVADA', 'gravou', false,
      'detalhe', 'a divida foi concluida pela liquidacao oficial na Prime e nao volta a ser cobrada',
      'origem_liquidacao_ref', v_t.origem_liquidacao_ref);
  end if;

  -- G3. Saída administrativa (Conferência Prime) tem porta própria e GUC
  -- próprio. Não se mexe por aqui.
  if v_t.origem_encerramento is not null then
    return jsonb_build_object('ok', false, 'motivo', 'ENCERRADO_ADMINISTRATIVAMENTE', 'gravou', false,
      'origem_encerramento', v_t.origem_encerramento);
  end if;

  -- G4. O boleto do próprio acordo nunca foi dívida de mensalidade: é o número
  -- do documento do acordo. Não tem atribuição a retirar.
  if coalesce(v_t.tipo_boleto, '') = 'Acordo' then
    return jsonb_build_object('ok', false, 'motivo', 'TITULO_DE_ACORDO', 'gravou', false);
  end if;

  -- G5. A FRONTEIRA COM A E6. Se a proveniência aponta para OUTRO acordo, o
  -- dinheiro que quitou este título entrou lá: o caso é MOVER a atribuição
  -- (E6), não retirá-la. Retirar aqui apagaria um lastro que existe.
  if v_t.origem_liquidacao_ref is not null
     and v_t.origem_liquidacao_ref <> p_acordo_id::text then
    return jsonb_build_object('ok', false, 'motivo', 'PROVENIENCIA_DE_OUTRO_ACORDO', 'gravou', false,
      'detalhe', 'a quitacao deste titulo foi atribuida a outro acordo; o caso e corrigir a atribuicao, nao retira-la',
      'origem_liquidacao_ref', v_t.origem_liquidacao_ref);
  end if;

  -- G6. PRESERVAR O PAGAMENTO LEGÍTIMO. Pagamento identificado no PRÓPRIO
  -- título (pelo número do documento) é lastro dele, não do acordo: reabrir
  -- cobraria de novo quem pagou. Pagamento de acordo carrega o número do
  -- ACORDO, não do título (Premissa 19), então não cai aqui por engano.
  select p.id::text into v_pag
    from public.pagamentos p
   where p.aluno_id = v_t.aluno_id
     and nullif(btrim(coalesce(p.titulo_numero, '')), '') is not null
     and ltrim(btrim(p.titulo_numero), '0') = ltrim(coalesce(v_t.documento, ''), '0')
   limit 1;
  if v_pag is not null then
    return jsonb_build_object('ok', false, 'motivo', 'TITULO_TEM_PAGAMENTO_PROPRIO', 'gravou', false,
      'detalhe', 'existe pagamento identificado no numero deste titulo; reabrir cobraria em dobro',
      'pagamento_id', v_pag);
  end if;

  select a.id, a.numero_acordo, a.numero_ulbra, upper(coalesce(a.status, '')) as status
    into v_ac
    from public.acordos a
   where a.id = p_acordo_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'ACORDO_NAO_ENCONTRADO', 'gravou', false);
  end if;

  -- G7. Precisa existir o vínculo ATIVO que se pretende desativar. Sem ele não
  -- há atribuição a retirar -- e o `ux_titulo_vinculo_ativo` garante que esse
  -- vínculo ativo é único por título.
  select v.id, v.criado_em, v.vinculado_por
    into v_vinc
    from public.acordo_titulo_vinculo v
   where v.titulo_id = p_titulo_id
     and v.acordo_id = p_acordo_id
     and coalesce(v.ativo, true)
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_VINCULO_ATIVO_NESTE_ACORDO', 'gravou', false,
      'detalhe', 'nao existe vinculo ativo entre este titulo e este acordo');
  end if;

  -- ============================ A CONTA DE COBERTURA =========================
  -- Dinheiro que o acordo recebeu: parcela PAGO. `RENEGOCIADA` não é parcela
  -- paga (mesma distinção que `titulo_reavaliar` faz na guarda de re-acordo).
  select coalesce(sum(p.valor), 0) into v_recebido
    from public.parcelas p
   where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status, '')) = 'PAGO';

  -- Mensalidade quitada ATRIBUÍDA a este acordo, pela âncora do cabeçalho.
  select coalesce(sum(coalesce(t.valor_original, t.saldo_corrigido, t.valor_em_aberto, 0)), 0)
    into v_quit_antes
    from public.acordos_titulos t
   where upper(coalesce(t.situacao, '')) = 'PAGO'
     and coalesce(t.tipo_boleto, '') <> 'Acordo'
     and (t.acordo_id = p_acordo_id or t.origem_liquidacao_ref = p_acordo_id::text);

  v_quit_depois := round(v_quit_antes - v_valor, 2);
  v_desc_antes  := round(v_quit_antes  - v_recebido, 2);
  v_desc_depois := round(v_quit_depois - v_recebido, 2);

  v_cobertura := jsonb_build_object(
    'recebido_no_acordo',   round(v_recebido, 2),
    'quitadas_antes',       round(v_quit_antes, 2),
    'quitadas_depois',      v_quit_depois,
    'descoberto_antes',     v_desc_antes,
    'descoberto_depois',    v_desc_depois,
    'valor_deste_titulo',   round(v_valor, 2));

  -- G8a. Sem descoberto o acordo cobre tudo o que quitou: não há evidência de
  -- atribuição sem lastro, e retirar seria desfazer uma quitação legítima.
  if v_desc_antes <= v_tol then
    return jsonb_build_object('ok', false, 'motivo', 'ACORDO_COBRE_AS_MENSALIDADES', 'gravou', false,
      'detalhe', 'o acordo recebeu o suficiente para as mensalidades que quitou; nao ha atribuicao sem lastro a retirar',
      'cobertura', v_cobertura);
  end if;

  -- G8b. Retirar ESTE título tem de FECHAR a conta. Se ainda sobra descoberto,
  -- o título escolhido não é (ou não é o único) sem lastro -- e trocar o
  -- problema de lugar não é corrigir.
  if v_desc_depois > v_tol then
    return jsonb_build_object('ok', false, 'motivo', 'REMOCAO_NAO_FECHA_A_CONTA', 'gravou', false,
      'detalhe', 'retirar este titulo nao elimina o descoberto do acordo; confira a composicao antes de decidir',
      'cobertura', v_cobertura);
  end if;

  v_antes := jsonb_build_object(
    'titulo_id',             p_titulo_id,
    'documento',             v_t.documento,
    'situacao',              v_t.situacao,
    'status',                v_t.status,
    'acordo_id',             v_t.acordo_id,
    'origem_liquidacao',     v_t.origem_liquidacao,
    'origem_liquidacao_ref', v_t.origem_liquidacao_ref,
    'vinculo_id',            v_vinc.id,
    'vinculo_criado_em',     v_vinc.criado_em,
    'vinculo_vinculado_por', v_vinc.vinculado_por,
    'acordo', jsonb_build_object('id', v_ac.id, 'numero_acordo', v_ac.numero_acordo,
                                 'numero_ulbra', v_ac.numero_ulbra, 'status', v_ac.status));

  -- O caso volta para a fila pelo cron das :35, não por aqui. Informar é
  -- diferente de fazer: a gestão precisa saber que o aluno não fica coerente
  -- no mesmo instante.
  select coalesce(bool_or(coalesce(c.encerrado_operacional, false)), false) into v_enc
    from public.casos c where c.aluno_id = v_t.aluno_id;

  -- SIMULAÇÃO É O PADRÃO. Devolve o estado anterior, o proposto e a conta que
  -- autoriza -- sem lock e sem escrever.
  if not coalesce(p_confirmar, false) then
    return jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false, 'aprovado', true,
      'estado_anterior',  v_antes,
      'estado_proposto',  jsonb_build_object('situacao', 'ABERTO', 'status', 'em_aberto',
                                             'acordo_id', null, 'vinculo_ativo', false),
      'cobertura',            v_cobertura,
      'caso_reabre_pelo_cron', v_enc,
      'motivo_informado',     v_motivo);
  end if;

  -- Confirmar sem dizer por quê deixa o livro de registro sem a única coluna
  -- que uma auditoria futura não consegue reconstruir.
  if v_motivo is null then
    return jsonb_build_object('ok', false, 'motivo', 'MOTIVO_OBRIGATORIO', 'gravou', false,
      'detalhe', 'informe p_motivo para confirmar');
  end if;

  -- Duas chamadas ao mesmo tempo: a segunda espera e, ao reler, é recusada
  -- pelas cláusulas de concorrência otimista abaixo.
  perform pg_advisory_xact_lock(hashtextextended('titulo_atribuicao_remover:' || p_titulo_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('acordo_composicao:' || p_acordo_id::text, 0));

  -- RELEITURA SOB LOCK. O estado pode ter mudado entre a conferência e aqui.
  select t.situacao, t.status, t.acordo_id into v_t2
    from public.acordos_titulos t where t.id = p_titulo_id for update;
  if upper(coalesce(v_t2.situacao, '')) <> upper(coalesce(v_t.situacao, ''))
     or lower(coalesce(v_t2.status, '')) <> lower(coalesce(v_t.status, '')) then
    raise exception 'ATRIBUICAO_REMOVER_ABORTADA: o titulo mudou de estado durante a transicao (%/% -> %/%)',
      v_t.situacao, v_t.status, v_t2.situacao, v_t2.status;
  end if;

  select v.id into v_vinc2
    from public.acordo_titulo_vinculo v
   where v.id = v_vinc.id and coalesce(v.ativo, true) for update;
  if not found then
    raise exception 'ATRIBUICAO_REMOVER_ABORTADA: o vinculo % deixou de estar ativo durante a transicao', v_vinc.id;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), 'gestao');

  v_texto := 'atribuicao retirada em '
    || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')
    || ': o acordo ' || coalesce(v_ac.numero_acordo::text, '?')
    || ' recebeu ' || public.fmt_brl(round(v_recebido, 2))
    || ' e carregava ' || public.fmt_brl(round(v_quit_antes, 2))
    || ' de mensalidade quitada, logo a divida desta mensalidade nao foi paga por ele. '
    || v_motivo;

  -- ESCRITA 1: o vínculo é DESATIVADO, nunca apagado. A composição do acordo e
  -- a cadeia que a guarda de re-acordo do motor lê continuam na tabela.
  -- O `and coalesce(ativo, true)` é concorrência otimista.
  update public.acordo_titulo_vinculo
     set ativo = false,
         motivo_desvinculo = v_texto
   where id = v_vinc.id
     and coalesce(ativo, true);
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ATRIBUICAO_REMOVER_ABORTADA: desativacao do vinculo afetou % linha(s)', v_n;
  end if;

  -- ESCRITA 2: o PAR INTEIRO num único update (ver o cabeçalho). A trinca de
  -- proveniência volta a NULL porque, depois daqui, o título NÃO está
  -- liquidado -- manter a marca seria registrar o contrário do fato.
  update public.acordos_titulos
     set situacao = 'ABERTO',
         status   = 'em_aberto',
         acordo_id = null,
         origem_liquidacao     = null,
         origem_liquidacao_ref = null,
         origem_liquidacao_em  = null,
         motivo_ajuste = coalesce(motivo_ajuste, '')
           || case when coalesce(motivo_ajuste, '') = '' then '' else ' | ' end
           || v_texto,
         atualizado_em = now()
   where id = p_titulo_id
     and situacao = v_t.situacao
     and status   = v_t.status;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ATRIBUICAO_REMOVER_ABORTADA: o par situacao/status do titulo mudou durante a transicao (% linha(s))', v_n;
  end if;

  -- PASSE DE CONFIRMAÇÃO. O motor agora atravessa a primeira guarda (não é
  -- mais PAGO) e decide de forma independente: sem vínculo ativo, ele mesmo
  -- escreve ABERTO/em_aberto/acordo_id nulo. Se chegar a OUTRA decisão, a
  -- premissa estava errada e a transação morre aqui.
  perform public.titulo_reavaliar(p_titulo_id);

  select t.situacao, t.status, t.acordo_id into v_depois
    from public.acordos_titulos t where t.id = p_titulo_id;

  if upper(coalesce(v_depois.situacao, '')) <> 'ABERTO'
     or lower(coalesce(v_depois.status, '')) <> 'em_aberto'
     or v_depois.acordo_id is not null then
    raise exception 'MOTOR_DISCORDOU: apos titulo_reavaliar o titulo ficou %/% com acordo_id %',
      coalesce(v_depois.situacao, '(null)'), coalesce(v_depois.status, '(null)'),
      coalesce(v_depois.acordo_id::text, '(null)');
  end if;

  -- O LIVRO DE REGISTRO, o mesmo das outras portas de mensalidade.
  insert into public.mensalidade_reconciliacao_log
    (lote, titulo_id, aluno_id, acordo_id, numero_acordo, documento, valor_original,
     situacao_antes, status_antes, situacao_depois, status_depois, motivo, executado_por)
  values
    (v_lote, p_titulo_id, v_t.aluno_id, p_acordo_id, v_ac.numero_acordo,
     v_t.documento, v_valor,
     v_t.situacao, v_t.status, v_depois.situacao, v_depois.status, v_texto, v_email);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'TITULO_ATRIBUICAO_REMOVIDA', 'acordos_titulos', p_titulo_id,
          jsonb_build_object(
            'estado_anterior',  v_antes,
            'estado_posterior', jsonb_build_object('situacao', v_depois.situacao,
                                                   'status', v_depois.status,
                                                   'acordo_id', v_depois.acordo_id,
                                                   'vinculo_id', v_vinc.id,
                                                   'vinculo_ativo', false),
            'cobertura',        v_cobertura,
            'motivo',           v_motivo,
            'lote',             v_lote,
            'sem_efeito_em_pagamento', true));

  -- SALDO E SITUAÇÃO OPERACIONAL. A dívida voltou: o saldo do aluno e a
  -- situação do caso são recalculados pela função canônica, não à mão.
  perform public.recalcular_situacao_aluno(v_t.aluno_id, 'e7_atribuicao_remover');

  return jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
    'titulo_id',       p_titulo_id,
    'documento',       v_t.documento,
    'acordo_id',       p_acordo_id,
    'numero_acordo',   v_ac.numero_acordo,
    'estado_anterior', v_antes,
    'situacao',        v_depois.situacao,
    'status',          v_depois.status,
    'vinculo_id',      v_vinc.id,
    'vinculo_ativo',   false,
    'cobertura',       v_cobertura,
    'valor_devolvido_a_cobranca', round(v_valor, 2),
    'caso_reabre_pelo_cron',      v_enc,
    'lote',            v_lote);
end;
$fn$;

comment on function public.titulo_atribuicao_remover(uuid, uuid, text, boolean) is
  'E7 (26/10/2026): retira a atribuicao de uma mensalidade que o acordo NAO pagou -- o titulo volta a ABERTO e o vinculo vira ativo=false, nunca apagado. Comeca em simulacao (p_confirmar=false). Portao de gestao OU diretoria. Exige prova de cobertura: ha descoberto no acordo ANTES e retirar este titulo FECHA a conta. Recusa PRIME_LIQUIDACAO_OFICIAL, encerramento administrativo, titulo de acordo, pagamento no proprio titulo e proveniencia de outro acordo (esse caso e a E6, que MOVE a atribuicao). Registra em mensalidade_reconciliacao_log (lote REMOVER_ATRIBUICAO_SEM_LASTRO) e em auditoria com estado anterior e posterior. Substituta segura de desvincular_titulos_acordo.';

-- O portão interno é que decide quem pode; o grant só diz quem alcança a
-- função. Reafirmar os dois é o padrão desde o PR #729.
revoke all on function public.titulo_atribuicao_remover(uuid, uuid, text, boolean) from public;
revoke all on function public.titulo_atribuicao_remover(uuid, uuid, text, boolean) from anon;
grant execute on function public.titulo_atribuicao_remover(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.titulo_atribuicao_remover(uuid, uuid, text, boolean) to service_role;
