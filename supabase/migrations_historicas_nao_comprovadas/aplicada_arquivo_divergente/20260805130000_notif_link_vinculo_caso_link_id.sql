-- Notificacoes NOVAS de link de pagamento: vinculo obrigatorio ao aluno, ao
-- caso e ao link/solicitacao, para que o clique no balao abra a ficha do aluno
-- correto (nunca a fila geral) e a secao "Link de pagamento" com a solicitacao
-- exata destacada. Nao altera notificacoes antigas (so o gatilho que cria as
-- NOVAS a partir de agora) e nao mexe em responsavel, pagamentos ou acordos.
--
-- Contexto de esquema (prod): a notificacao de "link pronto" e criada pelo
-- gatilho public.tg_links_criar_retorno_adm sobre a tabela links_pagamento,
-- onde a solicitacao e o link vivem na MESMA linha (new.id). O texto do balao
-- ja expoe apenas o nome do aluno -- sem CPF, token, URL ou valor -- e isso e
-- mantido. O link completo continua so dentro da ficha autorizada.

-- 1) Colunas de vinculo (aditivas, nullable). caso_id/link_pagamento_id nao
--    existiam; solicitacao_link_id e aluno_id ja existem.
alter table public.notificacoes
  add column if not exists caso_id uuid,
  add column if not exists link_pagamento_id uuid;

comment on column public.notificacoes.caso_id is
  'Caso operacional vinculado a notificacao (quando existir). Preenchido nas notificacoes de link.';
comment on column public.notificacoes.link_pagamento_id is
  'Link de pagamento vinculado (= links_pagamento.id quando ja ha link gerado). Preenchido nas notificacoes de link.';

-- 2) Gatilho de "link pronto": passa a gravar caso_id e link_pagamento_id, alem
--    de aluno_id e solicitacao_link_id (que ja gravava). url_destino vira a
--    ficha do aluno (nunca a fila), como defesa em profundidade -- o front ja
--    prioriza o aluno_id.
create or replace function public.tg_links_criar_retorno_adm()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_aluno uuid;
  v_dest  text := null;
  v_nome  text := null;
  v_mov   bigint;
  v_chave text;
  v_aluno_nome text;
  v_caso uuid;
  v_link_id uuid;
begin
  if new.status = 'LINK_PRONTO_PARA_ENVIO'
     and (tg_op = 'INSERT' or old.status is distinct from 'LINK_PRONTO_PARA_ENVIO') then
    begin
      begin v_aluno := new.aluno_id::uuid; exception when others then v_aluno := null; end;
      if v_aluno is null then return new; end if;

      if public.retorno_responsavel_valido(new.operador_solicitante) then
        v_dest := new.operador_solicitante;
      elsif public.retorno_responsavel_valido(new.operador_email) then
        v_dest := new.operador_email;
      else
        select responsavel_atual_email into v_dest from public.alunos where id = v_aluno;
        if not public.retorno_responsavel_valido(v_dest) then
          select operador_responsavel_email into v_dest
            from public.acordos where aluno_id = v_aluno and status = 'ATIVO'
            order by criado_em desc nulls last limit 1;
          if not public.retorno_responsavel_valido(v_dest) then v_dest := null; end if;
        end if;
      end if;

      if v_dest is not null then
        select coalesce(nome, apelido) into v_nome from public.usuarios where lower(email)=lower(v_dest) limit 1;
      end if;

      v_chave := 'links_pagamento:' || new.id::text || ':LINK_PRONTO_PARA_ENVIO';

      insert into public.retornos_adm(
        aluno_id, origem, solicitacao_id, tipo_solicitacao, resultado_adm,
        acionavel, motivo, proximo_passo, evento_conclusao_esperado, prioridade,
        operador_destino_email, operador_destino_nome, distribuicao,
        adm_email, adm_nome, chave_idempotencia
      ) values (
        v_aluno, 'links_pagamento', new.id::text, 'LINK', 'LINK_PRONTO_PARA_ENVIO',
        true, coalesce(new.observacao_solicitacao, new.observacao, 'Link pronto para envio'),
        'ENVIAR_LINK_AO_ALUNO', 'LINK_ENVIADO_AO_ALUNO', 'ALTA',
        v_dest, v_nome, case when v_dest is null then 'AGUARDANDO_DISTRIBUICAO' else null end,
        auth.email(), null, v_chave
      )
      on conflict (chave_idempotencia) do nothing
      returning id into v_mov;

      if v_mov is not null then
        insert into public.aluno_movimentacoes(
          aluno_id, tipo, descricao, status_anterior, status_novo,
          registrado_por_nome, registrado_por_email, registrado_em
        ) values (
          new.aluno_id, 'RETORNO_ADM_CRIADO',
          'Retorno do ADM: link pronto para envio' ||
            case when v_dest is null then ' (sem responsável válido — aguardando distribuição)'
                 else ' — destinado a ' || coalesce(v_nome, v_dest) end,
          null, 'LINK_PRONTO_PARA_ENVIO', 'Sistema (Retorno ADM)', auth.email(), now()
        );
        update public.retornos_adm set movimentacao_id = currval(pg_get_serial_sequence('public.aluno_movimentacoes','id'))
          where id = v_mov;

        -- >>> NOTIFICACAO EM TEMPO REAL (estoura na tela do operador destino)
        if v_dest is not null then
          select coalesce(nome_aluno, nome) into v_aluno_nome from public.alunos where id = v_aluno;

          -- Vinculo do caso operacional do aluno (quando existir).
          select id into v_caso from public.casos where aluno_id = v_aluno order by created_at desc nulls last limit 1;

          -- Vinculo do link: nesta base o link vive na mesma linha da solicitacao
          -- (new.id); so preenche link_pagamento_id quando ja existe URL gerada.
          v_link_id := case
            when coalesce(btrim(coalesce(new.link_pagamento, new.link_url)), '') <> '' then new.id
            else null
          end;

          insert into public.notificacoes(
            usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
            aluno_id, caso_id, solicitacao_link_id, link_pagamento_id, url_destino, lida, criado_em
          ) values (
            lower(v_dest), v_nome, 'LINK_PRONTO',
            '🔗 Seu link está pronto!',
            'O link de pagamento' || coalesce(' de ' || v_aluno_nome, '') || ' está pronto para envio. Envie ao aluno agora.',
            v_aluno::text, v_caso, new.id, v_link_id, '/aluno', false, now()
          );
        end if;
      end if;
    exception when others then
      raise notice 'tg_links_criar_retorno_adm falhou (ignorado p/ não travar link): %', sqlerrm;
    end;
  end if;
  return new;
end $function$;
