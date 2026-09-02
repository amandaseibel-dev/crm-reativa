-- ============================================================================
-- Backfill executado em PROD (ahattpqrjmhkzsmnbdzs) em 2026-08-25, junto com a
-- migration 20260825233000_proteger_prazo_fidelizacao_teto_e_redistribuicao.
--
-- O teto de 500 (trg_impor_teto_operador) soltou, nos ultimos 45 dias, 720
-- casos; ~318 estavam DENTRO dos 10 dias de fidelizacao. Destes, 235 seguiam
-- sem operador. Devolvidos apenas os 123 que AINDA estao dentro da janela hoje
-- -- os outros 112 ja passaram dos 11 dias sem acionamento e sao material
-- legitimo de pool/nivelamento (regra da Amanda: so se distribui o que esta sem
-- operador ou com 11+ dias sem acionamento).
--
-- O teto e desligado por sessao (calibragem.bypass_teto) durante a devolucao
-- para nao provocar soltura em cascata de outros casos do mesmo operador.
-- Backup: public._backup_teto_dentro_prazo_20260825 (RLS ligada, sem policy).
-- Resultado: 123 devolvidos, 123 com aluno sincronizado, 0 soltura colateral.
-- ============================================================================

select set_config('calibragem.bypass_teto','on',true);

create table if not exists public._backup_teto_dentro_prazo_20260825 (
  caso_id uuid, chave_unificacao text, operador_email_devolvido text, liberado_em timestamptz, criado_em timestamptz default now());
alter table public._backup_teto_dentro_prazo_20260825 enable row level security;

with h as (
  select distinct on (h.chave_unificacao) h.chave_unificacao, h.criado_em, h.operador_anterior_email
  from public.historico_operadores_alunos h
  where h.acao='LIBERACAO_AUTOMATICA_TETO_EXCEDIDO' and h.criado_em > now() - interval '45 days'
  order by h.chave_unificacao, h.criado_em desc
), alvo as (
  select h.* from h join public.alunos a on a.chave_unificacao=h.chave_unificacao
  where a.data_ultimo_acionamento is not null
    and a.data_ultimo_acionamento::date <= h.criado_em::date
    and a.data_ultimo_acionamento::date + 10 >= h.criado_em::date
)
insert into public._backup_teto_dentro_prazo_20260825 (caso_id, chave_unificacao, operador_email_devolvido, liberado_em)
select c.id, c.chave_unificacao, alvo.operador_anterior_email, alvo.criado_em
from alvo
join public.casos c on c.chave_unificacao = alvo.chave_unificacao
join public.usuarios u on lower(u.email)=lower(alvo.operador_anterior_email) and u.ativo=true and u.perfil='operador'
where c.operador_email is null
  and public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento);

update public.casos c
   set operador_email = u.email,
       operador_nome  = coalesce(u.operador_nome, u.nome),
       operador       = upper(coalesce(u.operador, u.nome)),
       caso_atualizado_por = 'backfill_teto_dentro_prazo_20260825',
       caso_atualizado_em  = now()
from public._backup_teto_dentro_prazo_20260825 b
join public.usuarios u on lower(u.email)=lower(b.operador_email_devolvido)
where c.id = b.caso_id and c.operador_email is null;

insert into public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
select c.chave_unificacao, c.nome, c.cpf, 'DEVOLUCAO_TETO_DENTRO_DO_PRAZO', c.operador_nome, c.operador_email,
       'Caso solto pelo teto de 500 dentro dos 10 dias de fidelizacao -- devolvido ao operador (correcao 25/08/2026)', now()
from public.casos c join public._backup_teto_dentro_prazo_20260825 b on b.caso_id=c.id;

-- Desfazer (se preciso): soltar de novo os casos devolvidos
-- update public.casos c set operador_email=null, operador_nome=null, operador=null
-- from public._backup_teto_dentro_prazo_20260825 b where c.id=b.caso_id;
