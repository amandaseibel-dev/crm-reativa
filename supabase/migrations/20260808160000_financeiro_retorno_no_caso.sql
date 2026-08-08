-- Retorno do financeiro DIRETO no caso (sem chat de e-mail).
--
-- Pedido da ADM: hoje o operador envia o caso ao financeiro (fila interna
-- solicitacoes_financeiro) e o retorno volta pelo chat do e-mail. Passamos a
-- registrar o retorno na PROPRIA solicitacao. Ao registrar:
--   1) a solicitacao vira status RETORNADO_FINANCEIRO com o texto do retorno;
--   2) o aluno volta a ser ACIONAVEL (proxima_acao RETORNAR) com status
--      "Retorno do financeiro recebido" -- some o selo 💰 e aparece o selo 📩
--      na carteira do operador;
--   3) uma notificacao em tempo real estoura na tela do operador dono do caso.
--
-- Gate identico ao que ja marca "enviado ao financeiro" na Fila do Financeiro
-- (podeGerirFinanceiro no front = Amanda ADM / gestora financeira). O gate e
-- revalidado aqui no backend por allowlist de e-mail (auth.email()).

-- 1) Colunas aditivas na solicitacao (nullable, nao quebram o fluxo atual).
alter table public.solicitacoes_financeiro
  add column if not exists retorno_financeiro text,
  add column if not exists retorno_em timestamptz,
  add column if not exists retorno_por text;

comment on column public.solicitacoes_financeiro.retorno_financeiro is
  'Texto do retorno do financeiro registrado direto no caso (substitui o chat de e-mail).';

-- 2) RPC: registra o retorno, reabre o caso e notifica o operador dono.
create or replace function public.financeiro_registrar_retorno(
  p_solicitacao_id uuid,
  p_texto text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_email      text := lower(coalesce(auth.email(), ''));
  v_aluno_id   text;
  v_aluno_nome text;
  v_operador   text;
  v_dest       text;
  v_aluno_uuid uuid;
begin
  -- Gate (1:1 com podeGerirFinanceiro no front).
  if v_email not in (
    'cobranca07@aelbra.com.br',
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br'
  ) then
    raise exception 'Sem permissao para registrar retorno do financeiro.'
      using errcode = '42501';
  end if;

  if p_texto is null or btrim(p_texto) = '' then
    raise exception 'Informe o texto do retorno do financeiro.';
  end if;

  update public.solicitacoes_financeiro
     set status = 'RETORNADO_FINANCEIRO',
         retorno_financeiro = btrim(p_texto),
         retorno_em = now(),
         retorno_por = v_email,
         atualizado_em = now()
   where id = p_solicitacao_id
   returning aluno_id, aluno_nome, operador_email
     into v_aluno_id, v_aluno_nome, v_operador;

  if v_aluno_id is null then
    raise exception 'Solicitacao financeira nao encontrada.';
  end if;

  -- Reabre o caso: volta acionavel para o operador tratar o retorno.
  update public.alunos
     set status_atual = 'Retorno do financeiro recebido',
         status_jornada = 'Retorno do financeiro recebido',
         status_acionamento = 'Retorno do financeiro recebido',
         proxima_acao = 'RETORNAR',
         data_retorno = now(),
         atualizado_em = now()
   where id::text = v_aluno_id;

  -- Destino da notificacao: dono ATUAL do caso (titularidade real), com
  -- fallback para quem abriu a solicitacao.
  begin v_aluno_uuid := v_aluno_id::uuid; exception when others then v_aluno_uuid := null; end;

  if v_aluno_uuid is not null then
    select responsavel_atual_email into v_dest
      from public.alunos where id = v_aluno_uuid;
  end if;
  if v_dest is null or btrim(v_dest) = '' then
    v_dest := v_operador;
  end if;

  -- Movimentacao (mantem o retorno dentro do historico do caso).
  insert into public.aluno_movimentacoes(
    aluno_id, tipo, descricao, status_novo,
    registrado_por_nome, registrado_por_email, registrado_em
  ) values (
    v_aluno_id, 'RETORNO_FINANCEIRO',
    'Retorno do financeiro: ' || btrim(p_texto),
    'Retorno do financeiro recebido',
    'Financeiro (ADM)', v_email, now()
  );

  -- Notificacao em tempo real na tela do operador dono.
  if v_dest is not null and btrim(v_dest) <> '' then
    insert into public.notificacoes(
      usuario_destino_email, tipo, titulo, mensagem,
      aluno_id, url_destino, lida, criado_em
    ) values (
      lower(v_dest), 'RETORNO_FINANCEIRO',
      '💰 Retorno do financeiro',
      'O financeiro respondeu' || coalesce(' o caso de ' || v_aluno_nome, '') ||
        '. Abra o caso para ver a resposta e dar sequencia.',
      v_aluno_id, '/aluno', false, now()
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'aluno_id', v_aluno_id,
    'notificado', v_dest
  );
end
$function$;

revoke all on function public.financeiro_registrar_retorno(uuid, text) from public, anon;
grant execute on function public.financeiro_registrar_retorno(uuid, text) to authenticated;
