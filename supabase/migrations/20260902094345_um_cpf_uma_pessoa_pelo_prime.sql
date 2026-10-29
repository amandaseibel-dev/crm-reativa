-- UM CPF, UMA PESSOA -- COM O NOME QUE O PRIME CONFIRMA.
--
-- Amanda, 02/09/2026: "veja no prime o cpf correto" / "deixe apenas os casos
-- corretos".
--
-- O PROBLEMA. Oito CPFs tinham DOIS cadastros com nomes de pessoas diferentes.
-- Nao era homonimo: era CPF trocado. A causa esta no cadastro manual, que checa
-- CPF repetido comparando TEXTO CRU (`.eq("cpf", cpf)`): quem digita
-- `001.235.702-20` passa pela trava porque a base guarda `00123570220`.
--
-- QUEM DECIDE E O PRIME. `GET /students?search={cpf}` devolve o nome do dono.
-- Consultado ao vivo em 02/09/2026 para os oito: em TODOS o dono e a pessoa do
-- cadastro mais NOVO (feito a mao pelo operador) -- o registro da carga de
-- 29/06 e que carrega CPF de outra gente.
--
-- ARMADILHA QUE EU CAI ANTES DE PERGUNTAR AO PRIME: tentei decidir cruzando
-- `acordos_titulos.documento` com `prime_titulo_semestre.boleto` e cheguei ao
-- OPOSTO. O raciocinio e circular -- os titulos foram importados POR CPF, entao
-- so confirmam o CPF que o CRM ja tinha. Titulo prova divida, nao identidade.
--
-- O QUE ISTO FAZ, por par: o cadastro com mais vinculos financeiros FICA e
-- recebe o nome que o Prime confirma; os titulos e acordos do outro sao
-- repontados para ele; o caso aberto do outro e encerrado (um aluno = um caso);
-- e o cadastro que sai fica no banco, fora da fila, apontando para quem ficou.
-- O CPF do que fica tambem e normalizado (so digitos) -- guardar com mascara e
-- o que criou a duplicidade.
--
-- MOVE DINHEIRO DE NOME. O caso pesado: R$ 85.330,51 que a fila mostrava como
-- "Adriane Ribeiro Andrade" estao no CPF que o Prime diz ser de WELITON CARDOSO
-- MENDES. A divida nao muda de valor nem sai da cobranca -- muda de nome e de
-- carteira. A Adriane verdadeira ja existe no CRM, com o CPF dela
-- (011.673.472-85) e R$ 166.334,07, com o Diego. Decisao da Amanda em 02/09.
--
-- O QUE ISTO **NAO** FAZ: nao mexe em titulo cujo boleto o Prime atribui a um
-- TERCEIRO CPF. Sao 3 casos ja medidos (Thais 1, Marco Antonio 2, Maria Rita 4)
-- e eles seguem colados onde estao -- problema anterior a este, que precisa de
-- decisao caso a caso. Ver o relatorio da sessao.
--
-- DESFAZER: supabase/rollbacks/20260902110000_um_cpf_uma_pessoa_pelo_prime.rollback.sql

create table if not exists public._fusao_cpf_prime_20260902 (
  cpf text, fica uuid, sai uuid, nome_prime text,
  nome_antigo_fica text, nome_aluno_antigo_fica text, cpf_antigo_fica text,
  status_antigo_sai text, status_jornada_antigo_sai text, saldo_antigo_sai numeric,
  observacao_antiga_sai text,
  titulos_movidos uuid[], acordos_movidos uuid[], casos_encerrados uuid[],
  aplicado_em timestamptz default now()
);
alter table public._fusao_cpf_prime_20260902 enable row level security;
drop policy if exists _fusao_cpf_prime_20260902_deny on public._fusao_cpf_prime_20260902;
create policy _fusao_cpf_prime_20260902_deny on public._fusao_cpf_prime_20260902
  for all to public using (false) with check (false);

do $$
declare
  p record;
  v_titulos uuid[];
  v_acordos uuid[];
  v_casos uuid[];
begin
  for p in
    select * from (values
      ('01922672050','56908563-c6a0-44bd-b89a-fa527c920c6c'::uuid,'cd7f6f22-4cb4-4c7e-808e-a9a05df7641c'::uuid,'Tábata Geret Souza da Silva'),
      ('02740813007','c4654dcf-3d42-4b11-a026-98264b380bdb'::uuid,'45d1e783-0b6d-4b84-b3cd-0c36f5827e14'::uuid,'Karen Maria Warpechowski Perrude'),
      ('03457566062','bccd37c3-3928-45c7-ac73-628d20dd7abc'::uuid,'40301e93-52e4-4b06-8b3e-7e6cd68c6a42'::uuid,'Isabela de Oliveira Peyrot'),
      ('03535217016','ba95dd98-65af-4812-acea-7a50be84373c'::uuid,'99cd7728-ce1e-408d-bf99-580aef4f9b0f'::uuid,'Ana Bella Rauber'),
      ('04009891157','4caec6e9-0659-4df3-9eca-671f107ee8d3'::uuid,'02b1b2fe-6202-490c-b717-3f77f0ef0508'::uuid,'Weliton Cardoso Mendes'),
      ('04044195188','c180555f-0bd2-475a-b3b1-6f4c29d11060'::uuid,'f353e5cf-b4e4-4078-bef5-9d0ae1b72a1d'::uuid,'Kivia Silva Almeida'),
      ('04379295079','7b54e1c7-9131-4d70-b1f5-8169d375fba7'::uuid,'788455f7-27d1-4ad8-91b6-972725b252a8'::uuid,'Franck Gasparoni de Vasconcelos Duarte'),
      ('06245159075','316d3845-3a2e-4c70-b87f-c9e90879158a'::uuid,'fb93adb4-98f6-4511-87a1-df51c31c2bca'::uuid,'Marco Antônio Hansen')
    ) as t(cpf, fica, sai, nome_prime)
  loop
    select coalesce(array_agg(id), '{}') into v_titulos from public.acordos_titulos where aluno_id = p.sai;
    select coalesce(array_agg(id), '{}') into v_acordos from public.acordos where aluno_id = p.sai;
    select coalesce(array_agg(id), '{}') into v_casos
      from public.casos where aluno_id = p.sai and not coalesce(encerrado_operacional, false);

    insert into public._fusao_cpf_prime_20260902(
      cpf, fica, sai, nome_prime, nome_antigo_fica, nome_aluno_antigo_fica, cpf_antigo_fica,
      status_antigo_sai, status_jornada_antigo_sai, saldo_antigo_sai, observacao_antiga_sai,
      titulos_movidos, acordos_movidos, casos_encerrados)
    select p.cpf, p.fica, p.sai, p.nome_prime, f.nome, f.nome_aluno, f.cpf,
           s.status_atual, s.status_jornada, s.saldo_total, s.observacao,
           v_titulos, v_acordos, v_casos
      from public.alunos f, public.alunos s
     where f.id = p.fica and s.id = p.sai;

    -- A divida do cadastro que sai passa para o que fica: mesmo CPF, mesma pessoa.
    update public.acordos_titulos set aluno_id = p.fica where aluno_id = p.sai;
    update public.acordos set aluno_id = p.fica where aluno_id = p.sai;

    -- Um aluno = um caso aberto: o caso do cadastro que sai e encerrado, nao movido.
    update public.casos set encerrado_operacional = true where id = any(v_casos);

    -- O que fica recebe o nome do Prime e o CPF sem mascara.
    update public.alunos
       set nome = p.nome_prime,
           nome_aluno = p.nome_prime,
           cpf = p.cpf,
           observacao = concat_ws(' | ', nullif(observacao, ''),
             'Nome corrigido em 02/09/2026 pela Ulbra Prime: o CPF ' || p.cpf ||
             ' pertence a ' || p.nome_prime || '. Cadastro anterior desse CPF foi unificado aqui.')
     where id = p.fica;

    -- O que sai fica no banco, fora da fila, dizendo para onde foi.
    update public.alunos
       set status_atual = 'SEM_SALDO_EM_ABERTO',
           status_jornada = 'SEM_SALDO_EM_ABERTO',
           saldo_total = 0,
           observacao = concat_ws(' | ', nullif(observacao, ''),
             'Cadastro duplicado do CPF ' || p.cpf || ', unificado em 02/09/2026 no cadastro de ' ||
             p.nome_prime || '. Titulos e acordos foram para la.')
     where id = p.sai;

    perform public.recalcular_situacao_aluno(p.fica, 'fusao_cpf_prime_20260902');
  end loop;
end $$;
