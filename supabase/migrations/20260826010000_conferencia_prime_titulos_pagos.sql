-- Conferência Prime: títulos que o CRM cobra e a Prime já registra liquidados.
--
-- CONTEXTO (investigação de 24/08/2026, ver docs e memória):
-- A Prime API só expõe parcelas LIQUIDADAS -- ausência lá não significa "pago",
-- significa "não sei". Por isso NADA aqui é automático: estas funções apenas
-- listam candidatos e baixam UM título por vez, por clique de gente autorizada.
--
-- ESCOLHA DA CHAVE: casamos por BOLETO = documento (1:1). Valor NÃO serve de
-- chave -- o CRM guarda o valor negociado e a Prime o cheio, e `paidAmount`
-- passa de `netAmount` em 89,4% dos casos (juros/correção). CPF + vencimento
-- funciona, mas casa 20 títulos a mais que o boleto: ficamos com o mais estrito.
--
-- TRAVA DE SEGURANÇA: aluno com acordo CANCELADO fica FORA. A Prime liquida a
-- mensalidade quando o aluno negocia e NÃO reverte se o acordo cai depois --
-- baixar nesse caso apagaria dívida viva. Em 25/08/2026 nenhum dos 61 alunos
-- candidatos tinha acordo cancelado, mas a trava fica para o dia em que tiver.

-- ---------------------------------------------------------------------------
-- 1) LISTAGEM (somente leitura)
-- ---------------------------------------------------------------------------
create or replace function public.prime_conferencia_listar()
returns table (
  titulo_id uuid,
  aluno_id uuid,
  aluno_nome text,
  cpf text,
  documento text,
  vencimento date,
  valor_em_aberto numeric,
  liquidado_em date,
  tem_acordo_ativo boolean,
  operador_responsavel text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    t.id                        as titulo_id,
    t.aluno_id,
    coalesce(a.nome, '-')       as aluno_nome,
    t.cpf,
    btrim(coalesce(t.documento,'')) as documento,
    t.vencimento,
    round(coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0), 2) as valor_em_aberto,
    p.liquidado_em,
    exists (
      select 1 from public.acordos ac
      where ac.aluno_id = t.aluno_id and ac.status = 'ATIVO'
    ) as tem_acordo_ativo,
    coalesce(a.responsavel_atual_nome, a.responsavel_atual_email, 'Sem responsável') as operador_responsavel
  from public.acordos_titulos t
  join public.prime_titulo_semestre p
    on btrim(coalesce(p.boleto,'')) = btrim(coalesce(t.documento,''))
   and coalesce(p.boleto,'') <> ''
  left join public.alunos a on a.id = t.aluno_id
  where public.crm_usuario_pode_quitar_baixar()
    and t.status = 'em_aberto'
    and p.liquidado_em is not null
    -- trava: aluno com acordo cancelado nunca entra na lista
    and not exists (
      select 1 from public.acordos ac
      where ac.aluno_id = t.aluno_id and ac.status = 'CANCELADO'
    )
  order by p.liquidado_em desc, t.vencimento;
$$;

revoke all on function public.prime_conferencia_listar() from public, anon;
grant execute on function public.prime_conferencia_listar() to authenticated;

comment on function public.prime_conferencia_listar() is
  'Títulos em aberto no CRM cujo boleto já consta liquidado na Prime. Somente leitura; exclui aluno com acordo CANCELADO. Gate: crm_usuario_pode_quitar_baixar().';

-- ---------------------------------------------------------------------------
-- 2) BAIXA DE UM TÍTULO (uma linha por chamada, sempre por clique humano)
-- ---------------------------------------------------------------------------
create or replace function public.prime_conferencia_baixar(
  p_titulo_id uuid,
  p_observacao text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulo   public.acordos_titulos%rowtype;
  v_liquidado date;
  v_valor    numeric;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode dar baixa em título.';
  end if;

  -- Trava a linha: duas pessoas conferindo a mesma lista não baixam duas vezes.
  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  -- Idempotente: já baixado devolve o estado, não erro.
  if v_titulo.status <> 'em_aberto' then
    return jsonb_build_object(
      'ja_processado', true,
      'status', v_titulo.status,
      'situacao', v_titulo.situacao
    );
  end if;

  -- REVALIDA no servidor. A tela pode estar velha; a prova tem que valer AGORA.
  select p.liquidado_em into v_liquidado
  from public.prime_titulo_semestre p
  where btrim(coalesce(p.boleto,'')) = btrim(coalesce(v_titulo.documento,''))
    and coalesce(p.boleto,'') <> ''
    and p.liquidado_em is not null
  limit 1;

  if v_liquidado is null then
    raise exception 'SEM_PROVA_NA_PRIME: este título não tem boleto liquidado na Prime.';
  end if;

  if exists (
    select 1 from public.acordos ac
    where ac.aluno_id = v_titulo.aluno_id and ac.status = 'CANCELADO'
  ) then
    raise exception 'ACORDO_CANCELADO: aluno tem acordo cancelado -- a liquidação na Prime pode ser da negociação que caiu. Conferir na mão.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_em_aberto, v_titulo.saldo_corrigido, v_titulo.valor_original, 0), 2);

  update public.acordos_titulos
     set status = 'quitada',
         situacao = 'PAGO'
   where id = p_titulo_id;

  -- Histórico: baixa por conferência precisa ser rastreável a uma pessoa.
  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Título', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferência com a Prime (liquidado em',
        to_char(v_liquidado, 'DD/MM/YYYY') || ').',
        nullif(btrim(coalesce(p_observacao,'')), '')
      ),
      v_email,
      now(),
      v_valor
    );
  end if;

  return jsonb_build_object(
    'ja_processado', false,
    'titulo_id', p_titulo_id,
    'valor_baixado', v_valor,
    'liquidado_em', v_liquidado
  );
end;
$$;

revoke all on function public.prime_conferencia_baixar(uuid, text) from public, anon;
grant execute on function public.prime_conferencia_baixar(uuid, text) to authenticated;

comment on function public.prime_conferencia_baixar(uuid, text) is
  'Baixa UM título cuja liquidação está provada na Prime (boleto). Revalida a prova no servidor, recusa aluno com acordo CANCELADO, é idempotente e grava histórico. Gate: crm_usuario_pode_quitar_baixar().';
