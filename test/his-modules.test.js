const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const diretorioTemporario = fs.mkdtempSync(path.join(os.tmpdir(), "baymax-his-"));
const arquivoDados = path.join(diretorioTemporario, "db.json");
const segredoAnterior = process.env.SESSION_SECRET;
const bancoAnterior = process.env.BAYMAX_DB_FILE;
process.env.SESSION_SECRET = "baymax-automated-tests-session-secret";
process.env.BAYMAX_DB_FILE = arquivoDados;

const agora = new Date().toISOString();
fs.writeFileSync(arquivoDados, JSON.stringify({
  usuarios: [
    { usuario: "admin", nome: "Admin de teste", senha: "senha-admin-teste", tipo: "admin" },
    { usuario: "medico", nome: "Médico de teste", senha: "senha-medico-teste", tipo: "medico" },
    { usuario: "medico2", nome: "Segundo médico de teste", senha: "senha-medico2-teste", tipo: "medico" },
    {
      usuario: "medicacao",
      nome: "Técnico(a) de Medicação (edite no painel admin)",
      senha: "senha-medicacao-teste",
      tipo: "medicacao"
    },
    { usuario: "enfermagem", nome: "Enfermagem de teste", senha: "senha-enfermagem-teste", tipo: "enfermagem" },
    { usuario: "tecnico", nome: "Técnico de teste", senha: "senha-tecnico-teste", tipo: "tecnico_enfermagem" },
    { usuario: "laboratorio", nome: "Laboratório de teste", senha: "senha-laboratorio-teste", tipo: "laboratorista" },
    { usuario: "centro", nome: "Centro cirúrgico de teste", senha: "senha-centro-teste", tipo: "centro_cirurgico" },
    { usuario: "recepcao", nome: "Recepção de teste", senha: "senha-recepcao-teste", tipo: "atendimento" }
  ],
  pessoas: [
    { id: 1, nome: "Paciente de teste", cpf: "000.000.000-00", alergias: ["Medicamento de teste"], createdAt: agora },
    { id: 2, nome: "Segundo paciente de teste", cpf: "111.111.111-11", alergias: [], createdAt: agora }
  ],
  medicacoesDisponiveis: [{ id: 1, nome: "Medicamento de teste", quantidade: 10 }]
}), "utf8");

const app = require("../backend/server");

async function chamada(base, rota, token, metodo = "GET", corpo) {
  const cabecalhos = {};
  if (token) cabecalhos.Authorization = `Bearer ${token}`;
  if (corpo !== undefined) cabecalhos["Content-Type"] = "application/json";
  const resposta = await fetch(base + rota, {
    method: metodo,
    headers: cabecalhos,
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });
  const texto = await resposta.text();
  return {
    status: resposta.status,
    dados: texto ? JSON.parse(texto) : null
  };
}

async function esperarStatus(base, rota, token, metodo, corpo, status) {
  const resposta = await chamada(base, rota, token, metodo, corpo);
  assert.equal(
    resposta.status,
    status,
    `${metodo} ${rota}: esperava ${status}, recebeu ${resposta.status}: ${JSON.stringify(resposta.dados)}`
  );
  return resposta.dados;
}

test("integra internação, enfermagem, laboratório e prontuário com permissões", async t => {
  const servidor = app.listen(0);
  t.after(async () => {
    await new Promise(resolve => servidor.close(resolve));
    fs.rmSync(diretorioTemporario, { recursive: true, force: true });
    if (segredoAnterior === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = segredoAnterior;
    if (bancoAnterior === undefined) delete process.env.BAYMAX_DB_FILE;
    else process.env.BAYMAX_DB_FILE = bancoAnterior;
  });

  await new Promise(resolve => servidor.once("listening", resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  async function entrar(usuario, senha, rota = "/login") {
    const resposta = await chamada(base, rota, null, "POST", { usuario, senha });
    assert.equal(resposta.status, 200);
    return resposta.dados.token;
  }

  const loginAdminComum = await chamada(base, "/login", null, "POST", {
    usuario: "admin",
    senha: "senha-admin-teste"
  });
  assert.equal(loginAdminComum.status, 401);

  const loginComumNoPainelAdmin = await chamada(base, "/login/admin", null, "POST", {
    usuario: "recepcao",
    senha: "senha-recepcao-teste"
  });
  assert.equal(loginComumNoPainelAdmin.status, 401);

  const admin = await entrar("admin", "senha-admin-teste", "/login/admin");
  const medico = await entrar("medico", "senha-medico-teste");
  const medico2 = await entrar("medico2", "senha-medico2-teste");
  const enfermagem = await entrar("enfermagem", "senha-enfermagem-teste");
  const tecnico = await entrar("tecnico", "senha-tecnico-teste");
  const laboratorio = await entrar("laboratorio", "senha-laboratorio-teste");
  const centro = await entrar("centro", "senha-centro-teste");
  const recepcao = await entrar("recepcao", "senha-recepcao-teste");

  await esperarStatus(base, "/usuarios", admin, "POST", {
    usuario: "setor-invalido",
    nome: "Setor não configurado",
    senha: "senha-invalida",
    tipo: "setor_invalido"
  }, 400);

  await esperarStatus(base, "/usuarios", admin, "POST", {
    usuario: "centro-novo",
    nome: "Novo centro cirúrgico",
    senha: "senha-centro-novo",
    tipo: "centro_cirurgico"
  }, 201);
  const leitoA = await esperarStatus(base, "/leitos", admin, "POST", {
    quarto: "301", numero: "A", setor: "Clínica"
  }, 201);
  const leitoB = await esperarStatus(base, "/leitos", admin, "POST", {
    quarto: "301", numero: "B", setor: "Clínica"
  }, 201);
  await esperarStatus(base, "/leitos", recepcao, "GET", undefined, 403);
  await esperarStatus(base, `/leitos/${leitoB.id}`, admin, "PATCH", { status: "manutencao" }, 200);

  const internacao = await esperarStatus(base, "/internacoes", enfermagem, "POST", {
    pessoaId: 1, leitoId: leitoA.id, motivo: "Observação de teste"
  }, 201);
  await esperarStatus(base, "/internacoes", enfermagem, "POST", {
    pessoaId: 1, leitoId: leitoB.id, motivo: "Internação duplicada"
  }, 409);
  await esperarStatus(base, "/internacoes", tecnico, "POST", {
    pessoaId: 2, leitoId: leitoB.id, motivo: "Sem permissão"
  }, 403);
  await esperarStatus(base, `/internacoes/${internacao.id}/transferencia`, enfermagem, "POST", {
    leitoId: leitoB.id
  }, 409);
  await esperarStatus(base, `/leitos/${leitoA.id}`, admin, "PATCH", { status: "manutencao" }, 409);
  await esperarStatus(base, `/leitos/${leitoB.id}`, admin, "PATCH", { status: "disponivel" }, 200);
  const transferida = await esperarStatus(base, `/internacoes/${internacao.id}/transferencia`, enfermagem, "POST", {
    leitoId: leitoB.id, motivo: "Transferência de teste"
  }, 200);
  assert.equal(transferida.transferencias.length, 1);
  assert.equal(transferida.leito.id, leitoB.id);

  await esperarStatus(base, "/enfermagem/evolucoes", tecnico, "POST", {
    internacaoId: internacao.id, registro: "Evolução de teste"
  }, 201);
  await esperarStatus(base, "/enfermagem/sinais-vitais", tecnico, "POST", {
    internacaoId: internacao.id, pressao: "120/80", temperatura: 36.8, saturacao: 98
  }, 201);
  await esperarStatus(base, "/enfermagem/sinais-vitais", tecnico, "POST", {
    internacaoId: internacao.id, temperatura: 999
  }, 400);
  await esperarStatus(base, "/enfermagem/balanco-hidrico", enfermagem, "POST", {
    internacaoId: internacao.id, tipo: "entrada", item: "Entrada de teste", ml: 1000
  }, 201);
  await esperarStatus(base, "/enfermagem/balanco-hidrico", enfermagem, "POST", {
    internacaoId: internacao.id, tipo: "saida", item: "Saída de teste", ml: 400
  }, 201);
  await esperarStatus(base, "/enfermagem/procedimentos", enfermagem, "POST", {
    internacaoId: internacao.id, procedimento: "Procedimento de teste"
  }, 201);
  const registros = (await chamada(base, `/enfermagem/registros/${internacao.id}`, enfermagem)).dados;
  assert.equal(registros.evolucoes.length, 1);
  assert.equal(registros.sinaisVitais.length, 1);
  assert.equal(registros.procedimentos.length, 1);
  assert.deepEqual(registros.totais24h, { entradaMl: 1000, saidaMl: 400, saldoMl: 600 });
  const dadosPrescricao = {
    medicacaoId: 1,
    dose: "1 unidade",
    via: "Oral",
    frequencia: "Conforme orientação médica",
    quantidade: 5
  };
  await esperarStatus(base, `/internacoes/${internacao.id}/prescricoes`, medico, "POST", dadosPrescricao, 409);
  const prescricao = await esperarStatus(base, `/internacoes/${internacao.id}/prescricoes`, medico, "POST", {
    ...dadosPrescricao,
    confirmarAlergia: true
  }, 201);
  await esperarStatus(base, `/prescricoes-internacao/${prescricao.id}/administrar`, recepcao, "POST", {
    quantidade: 2,
    idempotencia: "teste-chave-admin-001"
  }, 403);
  const administracao = await esperarStatus(base, `/prescricoes-internacao/${prescricao.id}/administrar`, tecnico, "POST", {
    quantidade: 2,
    idempotencia: "teste-chave-admin-001"
  }, 201);
  assert.equal(administracao.saldoEstoque, 8);
  const repetida = await esperarStatus(base, `/prescricoes-internacao/${prescricao.id}/administrar`, tecnico, "POST", {
    quantidade: 2,
    idempotencia: "teste-chave-admin-001"
  }, 200);
  assert.equal(repetida.duplicada, true);
  const estoque = await chamada(base, "/lista-medicacoes", medico);
  assert.equal(estoque.dados[0].quantidade, 8);
  await esperarStatus(base, `/prescricoes-internacao/${prescricao.id}/administrar`, tecnico, "POST", {
    quantidade: 4,
    idempotencia: "teste-chave-admin-002"
  }, 409);

  const exame = await esperarStatus(base, "/exames/catalogo", admin, "POST", {
    codigo: "TEST-001", nome: "Exame de teste"
  }, 201);
  await esperarStatus(base, "/exames/catalogo", admin, "POST", {
    codigo: "TEST-001", nome: "Exame duplicado"
  }, 409);
  await esperarStatus(base, "/exames", recepcao, "GET", undefined, 403);
  const solicitacao = await esperarStatus(base, "/exames", medico, "POST", {
    pessoaId: 1,
    exameId: exame.id,
    prioridade: "urgente",
    indicacao: "Indicação de teste",
    internacaoId: internacao.id
  }, 201);
  await esperarStatus(base, `/exames/${solicitacao.id}/resultado`, laboratorio, "POST", {
    resultado: "Resultado prematuro"
  }, 409);
  await esperarStatus(base, `/exames/${solicitacao.id}/coleta`, enfermagem, "POST", {}, 200);
  await esperarStatus(base, `/exames/${solicitacao.id}/resultado`, enfermagem, "POST", {
    resultado: "Sem permissão"
  }, 403);
  const resultado = await esperarStatus(base, `/exames/${solicitacao.id}/resultado`, laboratorio, "POST", {
    resultado: "Resultado textual de teste"
  }, 200);
  assert.equal(resultado.status, "resultado_liberado");

  const sala = await esperarStatus(base, "/cirurgias/salas", admin, "POST", {
    nome: "Sala de teste", local: "Unidade de teste"
  }, 201);
  const segundaSala = await esperarStatus(base, "/cirurgias/salas", admin, "POST", {
    nome: "Segunda sala de teste"
  }, 201);
  const procedimento = await esperarStatus(base, "/cirurgias/catalogo", admin, "POST", {
    codigo: "PROC-001", nome: "Procedimento de teste"
  }, 201);
  await esperarStatus(base, "/cirurgias/catalogo", admin, "POST", {
    codigo: "PROC-001", nome: "Procedimento duplicado"
  }, 409);
  await esperarStatus(base, "/cirurgias/salas", recepcao, "GET", undefined, 403);
  const inicioCirurgia = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cirurgia = await esperarStatus(base, "/cirurgias", medico, "POST", {
    pessoaId: 1,
    procedimentoId: procedimento.id,
    salaId: sala.id,
    cirurgiao: "medico",
    equipe: ["medico2"],
    inicio: inicioCirurgia,
    duracaoMinutos: 60,
    internacaoId: internacao.id,
    observacoes: "Observação cirúrgica de teste"
  }, 201);
  await esperarStatus(base, "/cirurgias", medico2, "POST", {
    pessoaId: 2,
    procedimentoId: procedimento.id,
    salaId: segundaSala.id,
    cirurgiao: "medico2",
    equipe: [],
    inicio: inicioCirurgia,
    duracaoMinutos: 60
  }, 409);
  await esperarStatus(base, "/cirurgias", centro, "POST", {
    pessoaId: 2,
    procedimentoId: procedimento.id,
    salaId: sala.id,
    cirurgiao: "medico2",
    equipe: [],
    inicio: inicioCirurgia,
    duracaoMinutos: 60
  }, 409);
  await esperarStatus(base, `/cirurgias/${cirurgia.id}/realizar`, medico2, "POST", {
    resumo: "Sem permissão"
  }, 403);
  const cirurgiasDoMedico = await chamada(base, "/cirurgias", medico);
  assert.equal(cirurgiasDoMedico.status, 200);
  assert.ok(cirurgiasDoMedico.dados.some(item => item.id === cirurgia.id));
  const cirurgiaRealizada = await esperarStatus(base, `/cirurgias/${cirurgia.id}/realizar`, medico, "POST", {
    resumo: "Procedimento concluído sem intercorrências",
    intercorrencias: ""
  }, 200);
  assert.equal(cirurgiaRealizada.status, "realizada");

  const listaProntuario = await chamada(base, "/prontuario?busca=Paciente", medico);
  assert.equal(listaProntuario.status, 200);
  assert.ok(listaProntuario.dados.some(item => item.cpf === "000.000.000-00"));
  const prontuario = await chamada(base, "/prontuario/paciente?cpf=000.000.000-00", medico);
  assert.equal(prontuario.status, 200);
  assert.equal(prontuario.dados.internacoes[0].sinaisVitais.length, 1);
  assert.equal(prontuario.dados.internacoes[0].prescricoes[0].administracoes.length, 1);
  assert.equal(prontuario.dados.exames[0].resultado, "Resultado textual de teste");
  assert.equal(prontuario.dados.cirurgias[0].resumo, "Procedimento concluído sem intercorrências");

  await esperarStatus(base, `/internacoes/${internacao.id}/alta`, enfermagem, "POST", {
    motivo: "Sem permissão"
  }, 403);
  await esperarStatus(base, `/internacoes/${internacao.id}/alta`, medico, "POST", {
    motivo: "Alta de teste"
  }, 200);
  const leitos = (await chamada(base, "/leitos", enfermagem)).dados;
  assert.ok(leitos.every(leito => leito.status === "disponivel"));
  const resumo = await chamada(base, "/relatorios/resumo?periodo=hoje", admin);
  assert.equal(resumo.dados.indicadoresHoje.internacoesAtivas, 0);
  assert.equal(typeof resumo.dados.indicadoresHoje.cirurgiasHoje, "number");
  assert.equal(resumo.dados.indicadoresHoje.leitosOcupados, 0);
  assert.equal(resumo.dados.indicadoresHoje.leitosDisponiveis, 2);
  assert.equal(resumo.dados.indicadoresHoje.examesPendentes, 0);

  const perfilAdmin = await esperarStatus(base, "/perfil", admin, "GET", undefined, 200);
  assert.equal(perfilAdmin.usuario, "admin");
  assert.equal(perfilAdmin.fotoPerfil, null);
  const fotoPerfil = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y5sAAAAASUVORK5CYII=";
  const perfilMedicoAdmin = await esperarStatus(
    base, "/usuarios/medico/perfil", admin, "PUT",
    { nome: "Médico atualizado pelo admin", fotoPerfil }, 200
  );
  assert.equal(perfilMedicoAdmin.nome, "Médico atualizado pelo admin");
  assert.equal(perfilMedicoAdmin.fotoPerfil, fotoPerfil);
  await esperarStatus(
    base, "/usuarios/medico2/perfil", admin, "PUT", { nome: "Nome curto temporário" }, 200
  );
  const perfilMedico2SemNome = await esperarStatus(
    base, "/usuarios/medico2/perfil", admin, "PUT", { nome: "   " }, 200
  );
  assert.equal(perfilMedico2SemNome.nome, "Segundo médico de teste");
  await esperarStatus(
    base, "/usuarios/medicacao/perfil", admin, "PUT", { nome: "Medicação" }, 200
  );
  const perfilMedicacaoSemNome = await esperarStatus(
    base, "/usuarios/medicacao/perfil", admin, "PUT", { nome: "" }, 200
  );
  assert.equal(perfilMedicacaoSemNome.nome, "Técnico(a) de Medicação (edite no painel admin)");
  const perfilMedicoAdminLido = await esperarStatus(
    base, "/usuarios/medico/perfil", admin, "GET", undefined, 200
  );
  assert.equal(perfilMedicoAdminLido.fotoPerfil, fotoPerfil);
  await esperarStatus(base, "/usuarios/admin/perfil", medico, "GET", undefined, 403);
  await esperarStatus(base, "/usuarios/admin/perfil", medico, "PUT", {
    nome: "Tentativa de alteração"
  }, 403);
  await esperarStatus(base, "/perfil", medico, "PUT", {
    nome: "Médico atualizado pelo próprio funcionário",
    fotoPerfil: "data:image/png;base64,SGVsbG8="
  }, 400);
  const perfilMedico = await esperarStatus(base, "/perfil", medico, "GET", undefined, 200);
  assert.equal(perfilMedico.fotoPerfil, fotoPerfil);
  const sessaoMedico = await esperarStatus(base, "/sessao", medico, "GET", undefined, 200);
  assert.equal(sessaoMedico.nome, "Médico atualizado pelo admin");
  assert.equal(sessaoMedico.fotoPerfil, fotoPerfil);
  await esperarStatus(base, "/perfil", medico, "PUT", {
    nome: "Nome atualizado pelo próprio funcionário"
  }, 200);
  const loginComFoto = await chamada(base, "/login", null, "POST", {
    usuario: "medico",
    senha: "senha-medico-teste"
  });
  assert.equal(loginComFoto.status, 200);
  assert.equal(loginComFoto.dados.fotoPerfil, fotoPerfil);
  const usuariosSemFoto = await chamada(base, "/usuarios", admin);
  assert.ok(usuariosSemFoto.dados.every(usuario => !Object.hasOwn(usuario, "fotoPerfil")));

  const usuariosPersistidos = JSON.parse(fs.readFileSync(arquivoDados, "utf8")).usuarios;
  assert.ok(usuariosPersistidos.every(usuario => usuario.senha.startsWith("scrypt$")));
  const medicoPersistido = usuariosPersistidos.find(usuario => usuario.usuario === "medico");
  assert.equal(medicoPersistido.nome, "Nome atualizado pelo próprio funcionário");
  assert.equal(medicoPersistido.fotoPerfil, fotoPerfil);
});
