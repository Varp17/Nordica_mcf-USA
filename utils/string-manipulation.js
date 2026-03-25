import _ from 'lodash'

const all = {
  formatString : function (inputString) {
    // Remove all spaces (including multiple spaces)
    const trimmedString = _.trim(inputString);

    const stringWithoutSpaces = _.replace(trimmedString, /\s/g, '-');

    // Convert the string to lowercase
    return _.toLower(stringWithoutSpaces);
  },

  renameFileExtension : function (fileName, newExtension) {
    const fileExtension = fileName.split('.').pop();
    return fileName.replace(`.${fileExtension}`, `.${newExtension}`);
  },

  removeFileExtension : function (fileName) {
    const fileExtension = fileName.split('.').pop();
    return fileName.replace(`.${fileExtension}`, '');
  }

}
export default all;