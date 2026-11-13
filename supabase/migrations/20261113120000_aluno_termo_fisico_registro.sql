-- Registro ADMINISTRATIVO da situação do termo físico (13/11/2026).
--
-- NÃO APLICAR EM PRODUÇÃO SEM REVISÃO E APROVAÇÃO. Esta migration só cria:
--   * tabela append-only `aluno_termo_fisico_eventos` (autor, data e hora);
--   * RLS que só deixa LER para `usuario_e_gestao()` (Amanda gestora, Fernanda
--     e Amanda ADM, os três e-mails cravados na função, conferidos em produção);
--   * RPCs `termo_fisico_ler` e `termo_fisico_registrar`, com o mesmo portão;
--   * linhas em `notificacoes` (canal existente), só para a gestão.
--
-- NÃO TOCA em: alunos, aluno_movimentacoes, casos, retorno, fila, fidelização,
-- acordos, parcelas, títulos, catálogo `tabulacoes` nem qualquer efeito
-- financeiro. "Arquivado" NÃO comprova quitação e NÃO gera baixa.

-- ----------------------------------------------------------------------------
-- 1. Tabela de eventos (append-only).
-- ----------------------------------------------------------------------------
create table if not exists public.aluno_termo_fisico_eventos (
  id            uuid        primary key default gen_random_uuid(),
  aluno_id      text        not null,
  situacao      text        not null check (situacao in ('EM_ANDAMENTO', 'ARQUIVADO')),
  autor_email   text        not null,
  registrado_em timestamptz not null default now()
);

create index if not exists aluno_termo_fisico_eventos_aluno_idx
  on public.aluno_termo_fisico_eventos (aluno_id, registrado_em desc);

alter table public.aluno_termo_fisico_eventos enable row level security;

-- Tabela nova herda privilégios padrão para authenticated (inclusive TRUNCATE):
-- zera tudo e devolve só o SELECT, que a RLS abaixo ainda restringe.
revoke all on public.aluno_termo_fisico_eventos from public, anon, authenticated;
grant select on public.aluno_termo_fisico_eventos to authenticated;

drop policy if exists aluno_termo_fisico_eventos_gestao_le on public.aluno_termo_fisico_eventos;
create policy aluno_termo_fisico_eventos_gestao_le
  on public.aluno_termo_fisico_eventos
  for select to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao());

-- Sem policy de INSERT, UPDATE ou DELETE para authenticated: a escrita só passa
-- pela RPC `termo_fisico_registrar`, que é SECURITY DEFINER.

-- Append-only de fato, inclusive para papéis de serviço: UPDATE e DELETE
-- levantam exceção. Sem isto, o "histórico" dependeria só de grant.
create or replace function public.aluno_termo_fisico_eventos_imutavel()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'registro de termo físico é append-only'
    using errcode = '42501';
end;
$$;

revoke all on function public.aluno_termo_fisico_eventos_imutavel() from public, anon, authenticated;

drop trigger if exists aluno_termo_fisico_eventos_sem_update_delete on public.aluno_termo_fisico_eventos;
create trigger aluno_termo_fisico_eventos_sem_update_delete
  before update or delete on public.aluno_termo_fisico_eventos
  for each row execute function public.aluno_termo_fisico_eventos_imutavel();

-- ----------------------------------------------------------------------------
-- 2. Leitura: situação atual + histórico. Recusa quem não é gestão.
-- ----------------------------------------------------------------------------
create or replace function public.termo_fisico_ler(p_aluno_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_eventos  jsonb;
  v_situacao text;
begin
  if not (public.app_usuario_ativo() and public.usuario_e_gestao()) then
    raise exception 'sem permissão para o registro do termo físico'
      using errcode = '42501';
  end if;

  if p_aluno_id is null or btrim(p_aluno_id) = '' then
    raise exception 'aluno obrigatório' using errcode = '22023';
  end if;

  select e.situacao
    into v_situacao
    from public.aluno_termo_fisico_eventos e
   where e.aluno_id = p_aluno_id
   order by e.registrado_em desc, e.id desc
   limit 1;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',            e.id,
               'situacao',      e.situacao,
               'autor_email',   e.autor_email,
               'registrado_em', e.registrado_em
             )
             order by e.registrado_em desc, e.id desc
           ),
           '[]'::jsonb)
    into v_eventos
    from public.aluno_termo_fisico_eventos e
   where e.aluno_id = p_aluno_id;

  return jsonb_build_object('situacao', v_situacao, 'eventos', v_eventos);
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Registro: grava o evento e, se pedido, avisa a gestão pelo canal existente.
-- ----------------------------------------------------------------------------
create or replace function public.termo_fisico_registrar(
  p_aluno_id  text,
  p_situacao  text,
  p_notificar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_dest  text;
  v_titulo_situacao text;
begin
  if not (public.app_usuario_ativo() and public.usuario_e_gestao()) then
    raise exception 'sem permissão para registrar o termo físico'
      using errcode = '42501';
  end if;

  if p_aluno_id is null or btrim(p_aluno_id) = '' then
    raise exception 'aluno obrigatório' using errcode = '22023';
  end if;

  if p_situacao is null or p_situacao not in ('EM_ANDAMENTO', 'ARQUIVADO') then
    raise exception 'situação inválida' using errcode = '22023';
  end if;

  insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email)
  values (p_aluno_id, p_situacao, v_email);

  if coalesce(p_notificar, false) then
    v_titulo_situacao := case
      when p_situacao = 'ARQUIVADO' then 'Termo físico arquivado'
      else 'Termo físico assinado, em andamento'
    end;

    -- Destinatários = os mesmos três e-mails de usuario_e_gestao(). Quem
    -- registrou não recebe o próprio aviso.
    foreach v_dest in array array[
      'amanda.seibel@aelbra.com.br',
      'cobranca04@aelbra.com.br',
      'cobranca07@aelbra.com.br'
    ] loop
      if v_dest <> v_email then
        insert into public.notificacoes (
          usuario_destino_email, tipo, titulo, mensagem,
          aluno_id, url_destino, lida, criado_em
        ) values (
          v_dest,
          'TERMO_FISICO',
          '📄 Termo físico registrado',
          v_titulo_situacao || ', registrado por ' || v_email || '.',
          p_aluno_id,
          '/aluno',
          false,
          now()
        );
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Grants das funções: nada para public/anon; só authenticated e service_role.
-- ----------------------------------------------------------------------------
revoke all on function public.termo_fisico_ler(text) from public, anon;
grant execute on function public.termo_fisico_ler(text) to authenticated;

revoke all on function public.termo_fisico_registrar(text, text, boolean) from public, anon;
grant execute on function public.termo_fisico_registrar(text, text, boolean) to authenticated;
