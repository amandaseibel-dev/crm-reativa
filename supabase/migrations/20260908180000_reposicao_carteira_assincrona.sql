-- Reposicao da carteira sai de dentro do clique.
--
-- Amanda, 08/09/2026: "as baixas estao demorando para processar" / "clico no
-- botao e tempo de resposta esta demorado".
--
-- O QUE ACONTECIA: quando uma baixa (ou "Quitar e encerrar", ou qualquer
-- outro caminho) quita um caso que ainda tem operador, o gatilho
-- `trigger_repor_caso_operador` libera a vaga E repoe a carteira do operador
-- na mesma transacao: conta os casos ativos, calcula quantos faltam para 500
-- e vai atribuindo casos sem dono, um a um. Cada atribuicao dispara mais dois
-- gatilhos pesados em `casos` (`trg_impor_teto_operador`, que reconta a
-- carteira inteira, e `trg_sincronizar_alunos_apos_casos`, que escreve no
-- aluno e na movimentacao). Medido em producao em 08/09 as 09:54: a baixa da
-- Rafaella repos 181 vagas de uma vez e o clique levou 18 segundos. Quando a
-- carteira ja esta cheia, a mesma baixa leva 30 ms.
--
-- O QUE MUDA: o gatilho continua fazendo a parte barata e imediata -- liberar
-- o caso e registrar a liberacao no historico -- e, em vez de repor ali, deixa
-- um pedido na fila `reposicao_carteira_fila`. Uma rotina (pg_cron, a cada
-- minuto) processa a fila com EXATAMENTE a mesma regra que estava no gatilho:
-- mesma meta de 500, mesma contagem, mesma ordem (2026 primeiro, valor perto
-- da media geral quando o caso fechou por quitacao), mesmos textos no
-- historico. A unica diferenca e o momento: a carteira e reposta ate um minuto
-- depois, fora da transacao de quem clicou.
--
-- Salvaguardas da rotina: pula a rodada se o sistema estiver sob carga
-- (`sistema_sob_carga`), processa no maximo 5 pedidos por rodada, e um pedido
-- de operador que deixou de ser operador ativo e marcado como processado sem
-- repor. Pedidos repetidos do mesmo operador sao baratos: a segunda contagem
-- ve a carteira ja cheia e nao atribui nada.
--
-- Falha ALTO: se a fila ficar sem rotina (pg_cron parado), os casos liberados
-- ficam sem dono ate alguem rodar `reposicao_carteira_processar()`. A tabela
-- e a coluna `processado_em` deixam isso visivel.

-- 1) A fila ---------------------------------------------------------------

create table if not exists public.reposicao_carteira_fila (
  id             bigserial primary key,
  operador_email text        not null,
  operador_nome  text,
  operador_upper text,
  tipo           text        not null,          -- 'QUITADO' | 'OUTRO' (tipo_fechamento_caso)
  caso_origem_id uuid,
  criado_em      timestamptz not null default now(),
  processado_em  timestamptz,
  repostos       int,
  erro           text
);

create index if not exists reposicao_carteira_fila_pendente_idx
  on public.reposicao_carteira_fila (criado_em)
  where processado_em is null;

alter table public.reposicao_carteira_fila enable row level security;
revoke all on table public.reposicao_carteira_fila from public, anon, authenticated;
-- Sem politica: so o dono (postgres) e as funcoes SECURITY DEFINER escrevem e leem.

comment on table public.reposicao_carteira_fila is
  'Pedidos de reposicao de carteira gerados por trigger_repor_caso_operador ao liberar um caso fechado. Processados por reposicao_carteira_processar() (pg_cron, a cada minuto). processado_em nulo = pendente.';

-- 2) O gatilho: libera e enfileira ------------------------------------------

create or replace function public.trg_repor_caso_operador()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email text := NEW.operador_email;
  v_nome  text := NEW.operador_nome;
  v_tipo  text;
begin
  if v_email is null then
    return NEW;
  end if;

  if not exists (select 1 from public.usuarios u where u.email = v_email and u.perfil = 'operador' and u.ativo = true) then
    return NEW;
  end if;

  if public.caso_protegido_redistribuicao(OLD.cpf_limpo, OLD.status_acionamento, OLD.nao_acionar, OLD.status_financeiro, OLD.valor_pago, OLD.quitado_em, OLD.valor_quitado) then
    return NEW;
  end if;

  if not public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) then
    return NEW;
  end if;

  v_tipo := public.tipo_fechamento_caso(NEW.cpf_limpo, NEW.status_acionamento, NEW.status_financeiro, NEW.quitado_em, NEW.valor_quitado);

  -- Parte imediata (barata): libera a vaga e registra.
  update public.casos
     set operador_email = null, operador_nome = null, operador = null
   where id = NEW.id;

  insert into public.historico_operadores_alunos (
    chave_unificacao, nome_aluno, cpf_referencia, acao,
    operador_anterior_nome, operador_anterior_email, observacao, criado_em
  ) values (
    NEW.chave_unificacao, NEW.nome, NEW.cpf, 'LIBERACAO_AUTOMATICA_CASO_FECHADO',
    v_nome, v_email,
    'Caso fechado (' || v_tipo || ', status: ' || coalesce(NEW.status_acionamento,'-') || ') -- liberado automaticamente', now()
  );

  -- Parte pesada (reposicao): fica para a rotina, fora desta transacao.
  insert into public.reposicao_carteira_fila (operador_email, operador_nome, operador_upper, tipo, caso_origem_id)
  values (v_email, v_nome, NEW.operador, v_tipo, NEW.id);

  return NEW;
end;
$$;

-- 3) A rotina: repoe com a mesma regra que estava no gatilho ---------------

create or replace function public.reposicao_carteira_processar(p_max_pedidos int default 5)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
declare
  v_meta int := 500;
  ped record;
  caso_rec record;
  v_qtd_ativa int;
  v_faltam int;
  v_repostos int;
  v_media_geral numeric;
  v_total_pedidos int := 0;
  v_total_repostos int := 0;
  v_sob_carga boolean := false;
begin
  -- Disjuntor: sob carga, esta rodada espera a proxima.
  begin
    v_sob_carga := coalesce((public.sistema_sob_carga() ->> 'sob_carga')::boolean, false);
  exception when others then
    v_sob_carga := false;
  end;
  if v_sob_carga then
    return jsonb_build_object('ok', true, 'pulado', 'sistema_sob_carga');
  end if;

  for ped in
    select f.*
      from public.reposicao_carteira_fila f
     where f.processado_em is null
     order by f.criado_em
     limit p_max_pedidos
       for update skip locked
  loop
    v_total_pedidos := v_total_pedidos + 1;
    v_repostos := 0;

    if not exists (select 1 from public.usuarios u where u.email = ped.operador_email and u.perfil = 'operador' and u.ativo = true) then
      update public.reposicao_carteira_fila
         set processado_em = now(), repostos = 0, erro = 'operador nao esta mais ativo'
       where id = ped.id;
      continue;
    end if;

    select count(*) into v_qtd_ativa
      from public.casos c
     where c.operador_email = ped.operador_email
       and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

    v_faltam := v_meta - v_qtd_ativa;

    if v_faltam > 0 then
      if ped.tipo = 'QUITADO' then
        select round(avg(coalesce(total_em_aberto,0))::numeric,2) into v_media_geral
          from public.casos where operador_email is not null and operador_email <> 'amanda.seibel@aelbra.com.br';

        for caso_rec in
          select id, chave_unificacao, nome, cpf, total_em_aberto
            from public.casos
           where operador_email is null
             and not public.caso_protegido_redistribuicao(cpf_limpo, status_acionamento, nao_acionar, status_financeiro, valor_pago, quitado_em, valor_quitado)
             and not public.caso_reservado_administrativo(chave_unificacao)
             and coalesce(total_em_aberto, 0) > 0
           order by public.caso_tem_titulo_2026(cpf_limpo) desc,
                    abs(coalesce(total_em_aberto,0) - coalesce(v_media_geral, coalesce(total_em_aberto,0))) asc
           limit v_faltam
        loop
          update public.casos
             set operador_email = ped.operador_email, operador_nome = ped.operador_nome, operador = ped.operador_upper,
                 caso_atualizado_por = 'sistema_reposicao_automatica_nivelada', caso_atualizado_em = now()
           where id = caso_rec.id;

          insert into public.historico_operadores_alunos (
            chave_unificacao, nome_aluno, cpf_referencia, acao,
            operador_nome, operador_email, observacao, criado_em
          ) values (
            caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'REPOSICAO_AUTOMATICA_VAGA',
            ped.operador_nome, ped.operador_email,
            'Reposicao nivelada (2026 primeiro, valor perto da media geral ' || coalesce(v_media_geral::text,'-') || ', caso anterior QUITADO) por ' || coalesce(ped.operador_nome, ped.operador_email), now()
          );
          v_repostos := v_repostos + 1;
        end loop;
      else
        for caso_rec in
          select id, chave_unificacao, nome, cpf, total_em_aberto
            from public.casos
           where operador_email is null
             and not public.caso_protegido_redistribuicao(cpf_limpo, status_acionamento, nao_acionar, status_financeiro, valor_pago, quitado_em, valor_quitado)
             and not public.caso_reservado_administrativo(chave_unificacao)
           order by public.caso_tem_titulo_2026(cpf_limpo) desc, (status_acionamento is null) desc, random()
           limit v_faltam
        loop
          update public.casos
             set operador_email = ped.operador_email, operador_nome = ped.operador_nome, operador = ped.operador_upper,
                 caso_atualizado_por = 'sistema_reposicao_automatica', caso_atualizado_em = now()
           where id = caso_rec.id;

          insert into public.historico_operadores_alunos (
            chave_unificacao, nome_aluno, cpf_referencia, acao,
            operador_nome, operador_email, observacao, criado_em
          ) values (
            caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'REPOSICAO_AUTOMATICA_VAGA',
            ped.operador_nome, ped.operador_email,
            'Reposicao (2026 primeiro, caso anterior foi ' || ped.tipo || ') por ' || coalesce(ped.operador_nome, ped.operador_email), now()
          );
          v_repostos := v_repostos + 1;
        end loop;
      end if;
    end if;

    update public.reposicao_carteira_fila
       set processado_em = now(), repostos = v_repostos
     where id = ped.id;

    v_total_repostos := v_total_repostos + v_repostos;
  end loop;

  return jsonb_build_object('ok', true, 'pedidos', v_total_pedidos, 'repostos', v_total_repostos);
end;
$$;

revoke all on function public.reposicao_carteira_processar(int) from public, anon, authenticated;
grant execute on function public.reposicao_carteira_processar(int) to service_role;

comment on function public.reposicao_carteira_processar(int) is
  'Processa a fila reposicao_carteira_fila: para cada pedido, conta a carteira ativa do operador e repoe ate 500 com a mesma regra que trigger_repor_caso_operador aplicava inline. Chamada pelo pg_cron a cada minuto.';

-- 4) Agendamento (so onde ha pg_cron; staging nao tem) -----------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'reposicao_carteira_minuto') then
      perform cron.schedule('reposicao_carteira_minuto', '* * * * *', 'select public.reposicao_carteira_processar();');
    end if;
  end if;
end $$;
