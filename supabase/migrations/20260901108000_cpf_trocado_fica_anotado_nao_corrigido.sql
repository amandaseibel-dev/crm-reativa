-- Amanda, 01/09: "procure o cpf correto no prime e atulize" e depois
-- "pode ser, e veja as parcelas em aberto se bate e corrija o cadastro".
--
-- Sete alunos estao cadastrados com o CPF de OUTRA pessoa. O Prime confirmou o
-- CPF correto de cada um. Mas a conferencia das parcelas mostrou que NENHUM
-- titulo em aberto desses cadastros bate com o CPF correto -- a divida entrou
-- PELO CPF, entao ela pertence a quem tem o CPF errado.
--
-- Trocar o CPF sozinho levaria a divida da outra pessoa junto. O caso da
-- Adriane Ribeiro Andrade carrega R$ 85.330,51 nessa condicao.
--
-- Por isso a tabela ANOTA e nao corrige: o conserto exige decidir, boleto a
-- boleto, para qual cadastro vai cada titulo -- e isso so se sabe olhando o
-- Prime caso a caso.

create table if not exists public.cpf_trocado_conferir (
  aluno_id          uuid primary key,
  nome              text,
  cpf_no_crm        text,
  cpf_correto_prime text,
  matricula_prime   text,
  dono_real_do_cpf  text,
  saldo             numeric,
  titulos_abertos   int,
  observacao        text,
  anotado_em        timestamptz not null default now(),
  resolvido_em      timestamptz,
  resolvido_por     text
);

alter table public.cpf_trocado_conferir enable row level security;
revoke all on public.cpf_trocado_conferir from anon;

drop policy if exists cpf_trocado_gestao on public.cpf_trocado_conferir;
create policy cpf_trocado_gestao on public.cpf_trocado_conferir
  for select to authenticated using (public.usuario_e_gestao());
