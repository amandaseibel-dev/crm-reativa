-- MESMA PESSOA COM DOIS CPFs: UM CADASTRO SO, NO CPF QUE O PRIME CONFIRMA.
--
-- Amanda, 02/09/2026: "deixe apenas os casos corretos".
--
-- COMO APARECERAM. Estes cinco NAO estavam na lista de CPF repetido -- os CPFs
-- sao diferentes, entao a base os tratava como homonimos. O que os denunciou
-- foi o Prime: um boleto preso ao cadastro A e atribuido, la, ao CPF do
-- cadastro B. Confirmado depois um a um em `GET /students?search={nome}`, que
-- devolve o CPF verdadeiro da pessoa -- e em todos os cinco ele e o do
-- cadastro B.
--
-- O caso mais didatico e a Bruna Cristine Pavao Vinder: `004.972.375-04` e
-- `049.723.750-43`. Sao os mesmos digitos deslocados uma casa -- erro de
-- digitacao que criou uma segunda pessoa e partiu a divida em duas fichas
-- (R$ 6.498,16 + R$ 4.291,04).
--
-- O CADASTRO QUE FICA E O DO CPF CERTO -- mas ele HERDA o trabalho do outro
-- quando o outro tem mais: responsavel, ultimo acionamento, status e retorno.
-- Sem isso a fusao premiaria o cadastro certo e apagaria o atendimento real:
-- na Bruna, os R$ 6.498,16 e o caso aberto estao no cadastro do CPF ERRADO, e
-- o dono (Olga) esta no do CPF certo.
--
-- FORA DESTA MIGRATION: THAUANE CAMPOS PIMENTEL. A fusao dela foi TENTADA e a
-- trava `tg_acordo_bloquear_duplicado` recusou, com razao: o cadastro do CPF
-- certo tem um acordo ATIVO de R$ 4.675,29 em 6x (nº 3795, de 31/08/2026) e o
-- do CPF errado tem outros dois, somando R$ 12.695,13. Juntar criaria acordo
-- duplicado no mesmo aluno -- exatamente o que a trava existe para impedir.
-- Decidir se o de 31/08 substitui os anteriores ou se sao negociacoes
-- diferentes e da gestao; ver [[dois-acordos-ativos-sao-dividas-diferentes]].
-- O exemplo da Thauane vale guardar: a trava de acordo protege a fusao, entao
-- toda fusao que mexe em `acordos` precisa conferir os acordos ATIVOS dos dois
-- lados ANTES de repontar.
--
-- Titulos, acordos e o caso aberto do que sai vao para o que fica (o caso, por
-- ser duplicado, e encerrado -- um aluno, um caso). O que sai permanece no
-- banco, fora da fila, apontando para onde foi.
--
-- DESFAZER: supabase/rollbacks/20260902120000_mesma_pessoa_dois_cpfs_pelo_prime.rollback.sql

create table if not exists public._fusao_mesma_pessoa_20260902 (
  nome text, fica uuid, sai uuid, cpf_certo text, cpf_errado text,
  fica_resp_email_antes text, fica_resp_nome_antes text, fica_resp_em_antes timestamptz,
  fica_acionamento_antes timestamptz, fica_status_antes text, fica_jornada_antes text,
  fica_retorno_antes date, fica_observacao_antes text,
  sai_status_antes text, sai_jornada_antes text, sai_saldo_antes numeric, sai_observacao_antes text,
  titulos_movidos uuid[], acordos_movidos uuid[], casos_encerrados uuid[],
  aplicado_em timestamptz default now()
);
alter table public._fusao_mesma_pessoa_20260902 enable row level security;
drop policy if exists _fusao_mesma_pessoa_20260902_deny on public._fusao_mesma_pessoa_20260902;
create policy _fusao_mesma_pessoa_20260902_deny on public._fusao_mesma_pessoa_20260902
  for all to public using (false) with check (false);

do $$
declare
  p record; f record; s record;
  v_titulos uuid[]; v_acordos uuid[]; v_casos uuid[];
begin
  for p in
    select * from (values
      ('Ana Carolina Larroza Alsina','c12edf4b-2aa8-4d95-9128-772137b42791'::uuid,'638dbe05-ebff-4d83-b7cc-86513719cf9c'::uuid,'03507763001','96985615015'),
      ('Bruna Cristine Pavao Vinder','8857ab6e-6260-4972-ae6c-63fc0a140184'::uuid,'a52765b5-7fb8-470e-8abe-6f5a27ea6dc8'::uuid,'04972375043','00497237504'),
      ('Esequiel Marques Gonçalves','76a26906-de92-4307-bdd8-6dba10facc01'::uuid,'b1081544-3db4-4219-836e-0b9fb8277241'::uuid,'48864340025','03325439004'),
      ('Fernanda Basso','164aa47c-7fd5-44d2-8790-6b1fb2f95d87'::uuid,'687c3bb8-9dd5-4927-bd53-33089a63b572'::uuid,'63534967020','02147268003')
    ) as t(nome, fica, sai, cpf_certo, cpf_errado)
  loop
    select * into f from public.alunos where id = p.fica;
    select * into s from public.alunos where id = p.sai;

    select coalesce(array_agg(id),'{}') into v_titulos from public.acordos_titulos where aluno_id = p.sai;
    select coalesce(array_agg(id),'{}') into v_acordos from public.acordos where aluno_id = p.sai;
    select coalesce(array_agg(id),'{}') into v_casos
      from public.casos where aluno_id = p.sai and not coalesce(encerrado_operacional,false);

    insert into public._fusao_mesma_pessoa_20260902(
      nome, fica, sai, cpf_certo, cpf_errado,
      fica_resp_email_antes, fica_resp_nome_antes, fica_resp_em_antes,
      fica_acionamento_antes, fica_status_antes, fica_jornada_antes, fica_retorno_antes, fica_observacao_antes,
      sai_status_antes, sai_jornada_antes, sai_saldo_antes, sai_observacao_antes,
      titulos_movidos, acordos_movidos, casos_encerrados)
    values (p.nome, p.fica, p.sai, p.cpf_certo, p.cpf_errado,
      f.responsavel_atual_email, f.responsavel_atual_nome, f.responsavel_atual_em,
      f.data_ultimo_acionamento, f.status_atual, f.status_jornada, f.data_retorno, f.observacao,
      s.status_atual, s.status_jornada, s.saldo_total, s.observacao,
      v_titulos, v_acordos, v_casos);

    update public.acordos_titulos set aluno_id = p.fica where aluno_id = p.sai;
    update public.acordos set aluno_id = p.fica where aluno_id = p.sai;
    update public.casos set encerrado_operacional = true where id = any(v_casos);

    -- O que fica herda o que so o outro tinha: dono, acionamento, status, retorno.
    update public.alunos
       set cpf = p.cpf_certo,
           responsavel_atual_email = coalesce(f.responsavel_atual_email, s.responsavel_atual_email),
           responsavel_atual_nome  = coalesce(f.responsavel_atual_nome,  s.responsavel_atual_nome),
           responsavel_atual_em    = coalesce(f.responsavel_atual_em,    s.responsavel_atual_em),
           data_ultimo_acionamento = greatest(
             coalesce(f.data_ultimo_acionamento, s.data_ultimo_acionamento),
             coalesce(s.data_ultimo_acionamento, f.data_ultimo_acionamento)),
           status_atual   = coalesce(f.status_atual,   s.status_atual),
           status_jornada = coalesce(f.status_jornada, s.status_jornada),
           data_retorno   = coalesce(f.data_retorno,   s.data_retorno),
           telefone       = coalesce(nullif(f.telefone,''), s.telefone),
           matricula      = coalesce(nullif(f.matricula,''), s.matricula),
           observacao = concat_ws(' | ', nullif(f.observacao,''),
             'Unificado em 02/09/2026: a mesma pessoa estava cadastrada tambem no CPF ' ||
             p.cpf_errado || '. O CPF correto (' || p.cpf_certo || ') foi confirmado na Ulbra Prime.')
     where id = p.fica;

    update public.alunos
       set status_atual = 'SEM_SALDO_EM_ABERTO',
           status_jornada = 'SEM_SALDO_EM_ABERTO',
           saldo_total = 0,
           observacao = concat_ws(' | ', nullif(s.observacao,''),
             'Cadastro com CPF errado (' || p.cpf_errado || '), unificado em 02/09/2026 no cadastro de CPF ' ||
             p.cpf_certo || ', confirmado na Ulbra Prime. Titulos e acordos foram para la.')
     where id = p.sai;

    perform public.recalcular_situacao_aluno(p.fica, 'fusao_mesma_pessoa_20260902');
  end loop;
end $$;
